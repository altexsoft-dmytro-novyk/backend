import request from 'supertest';
import type { TestApp } from './fixtures';
import { RunFixtures, bearer, bootstrapTestApp } from './fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.2 (UMAC-2) · AD-1 Stage 2.
 *
 * Scenarios (one E2E per assertion, `UMAC-xx` id in the test title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     umac-07-write-dual-gate.md
 *     umac-08-write-rejects-org-fields.md
 *     umac-09-photo-write-self-only.md
 *
 * VARIANT A (product decision 2026-09-02, Dmytro Novyk). The employee identity
 * card (profile:identity) has **no separate functional permission**. The whole gate on
 * `PATCH /users/:id` is `canAccessSection(viewer, 'profile:identity', target) === 'write'` —
 * i.e. the target's reporting-line manager or assigned People Partner may edit;
 * self / colleague may not. §2.2's functional-permission half is NOT applied to
 * this section. The string `user-management:edit` survives only as the adapter's
 * internal routing key for the PATCH-gate branch. There is NO dependency on a
 * `user-management:edit` kernel seed.
 *
 * UPDATE 2026-09-03: `access-control-facade.adapter.ts` `canEditS1` now ALSO
 * honours a live `user-management:edit` FR grant as an OR-override on the base
 * section gate (what `scripts/dev-grant-root.ts` relies on). It only widens — a
 * `'none'` section result (deactivated / unknown target) stays closed. Covered
 * by the "OR-override" describe block below; a full rewrite of the per-section
 * predicates is tracked in the access-control deferred-work.
 *
 * STATE (per group):
 *   - UMAC-07 — GREEN. `access-control-facade.adapter.ts` `isAllowedForTarget`'s
 *     `EDIT_USER_FEATURE` branch returns `canAccessSection('profile:identity') === 'write'`, so
 *     a reporting-line manager / assigned PP `PATCH` succeeds, and a
 *     colleague / self / unresolved `PATCH` is `403`.
 *   - UMAC-08 — RED until Epic 1 Story 1.2 Stage 3. `UpdateUserDto` does not
 *     declare `manager` / `peoplePartner` / `department`, so `ValidationPipe`
 *     `whitelist: true` SILENTLY STRIPS them and the request `200`s on the
 *     sibling field. Story 1.2 adds explicit `@IsEmpty()` rejection (`400`).
 *   - UMAC-09 — GREEN. Photo write is Self-only via `@SelfOnly` / `SelfOnlyGuard`
 *     (`viewer id == target id`) — a pure identity check, no facade call, no
 *     permission key (Open Decision vi). It never consulted `user-management:edit`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` rows and issue
 * `Bearer <token:<seeded-uuid>>`.
 */
describe('UMAC-2 Stage 2 — PATCH / PUT photo write-path gates (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const patch = (
    targetId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(testApp.app.getHttpServer())
      .patch(`/users/${targetId}`)
      .set('authorization', bearer(viewerId))
      .send(body);

  const getUser = (targetId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  const putPhoto = (targetId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .put(`/users/${targetId}/photo`)
      .set('authorization', bearer(viewerId))
      .attach('photo', Buffer.from('fake-jpeg-bytes'), `${targetId}.jpg`);

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // docs/test-cases/user-management/access-control-adoption/umac-07-write-dual-gate.md
  //
  // VARIANT A: identity-card edit is gated by profile:identity write-access alone —
  // `canAccessSection(V, 'profile:identity', T) === 'write'` (reporting-line manager or
  // assigned People Partner). No functional-permission half; no
  // `user-management:edit` seed. GREEN.
  describe('UMAC-07 · PATCH /users/:id identity-card edit is gated by profile:identity write-access (Variant A)', () => {
    it('UMAC-07 Test 3 — colleague (no reporting/PP edge) PATCH profile:identity → 403 [canAccessSection = "read"]', async () => {
      const viewer = await fx.user('umac07-colleague', {
        firstName: 'Colleague',
      });
      const target = await fx.user('umac07-target-c', { position: 'Engineer' });
      // No Relationship edge either direction → V is only `colleague` over T →
      // canAccessSection(V, 'profile:identity', T) === 'read', not 'write' → the edit gate denies.

      const res = await patch(target.id, viewer.id, {
        position: 'Principal Engineer',
      });
      expect(res.status).toBe(403);

      const readBack = await getUser(target.id, viewer.id);
      expect(readBack.body).toMatchObject({ data: { position: 'Engineer' } });
    });

    it('UMAC-07 Test 4 — Self PATCH of a non-photo profile:identity field → 403 [profile:identity is "read" for self; only the photo is Self-writable]', async () => {
      const self = await fx.user('umac07-self', { position: 'Engineer' });
      // §3.2: the profile:identity card is `R` for Self; a reporting-line / PP audience
      // is required to WRITE profile:identity. Self writes only the photo (umac-09).

      const res = await patch(self.id, self.id, { position: 'Staff Engineer' });
      expect(res.status).toBe(403);

      const readBack = await getUser(self.id, self.id);
      expect(readBack.body).toMatchObject({ data: { position: 'Engineer' } });
    });

    it('UMAC-07 Test 5 — unresolved session (Bearer <token:Bob>) PATCH → 401', async () => {
      const target = await fx.user('umac07-target-u', { position: 'Engineer' });
      // `Bearer <token:Bob>` → persona 'Bob' matches no active User → the
      // session does not resolve → `401` (unresolved session), before any
      // audience/gate check. Epic 2's real resolver replaced the lax interim
      // one that used to surface this as `403`.

      const res = await request(testApp.app.getHttpServer())
        .patch(`/users/${target.id}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ position: 'Ghost Engineer' });
      expect(res.status).toBe(401);
    });

    it('UMAC-07 Test 1 — reporting-line manager PATCHes a report’s profile:identity → 200, change persists', async () => {
      // Variant A: the reporting edge alone gives `canAccessSection('profile:identity') ===
      // 'write'`, which is the whole gate. No FR grant is seeded — the identity
      // card has no functional-permission layer.
      const manager = await fx.user('umac07-mgr', { firstName: 'Manager' });
      const alice = await fx.user('umac07-alice', {
        firstName: 'Alice',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workPhone: '+48 100 200 300',
      });
      await fx.reportsTo(alice.id, manager.id);

      const res = await patch(alice.id, manager.id, {
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });

      const readBack = await getUser(alice.id, manager.id);
      expect(readBack.body).toMatchObject({
        data: {
          position: 'Senior Engineer',
          country: 'DE',
          city: 'Berlin',
          workPhone: '+49 30 000000',
        },
        canEdit: true,
      });
    });

    it('UMAC-07 Test 2 — assigned People Partner PATCHes an employee’s profile:identity → 200, change persists', async () => {
      // Variant A: the `people_partner` edge gives `canAccessSection('profile:identity') ===
      // 'write'` — the assigned PP is the second entitled writer.
      const pp = await fx.user('umac07-pp', { firstName: 'PeoplePartner' });
      const employee = await fx.user('umac07-employee', {
        firstName: 'Employee',
        position: 'Engineer',
      });
      await fx.peoplePartnerOf(employee.id, pp.id);

      const res = await patch(employee.id, pp.id, {
        position: 'Senior Engineer',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ position: 'Senior Engineer' });

      const readBack = await getUser(employee.id, pp.id);
      expect(readBack.body).toMatchObject({
        data: { position: 'Senior Engineer' },
        canEdit: true,
      });
    });
  });

  // `umac-10` (the `user-management:edit` FR-grant OR-override describe block,
  // added 2026-09-03) was RETIRED here by PLAT-E4-S4.1c.
  //
  // Why: 4.1c moved `PATCH /users/:id` and the `canEdit` hint off
  // `isAllowedForTarget` → `canEditS1` onto the audience-first dual gate
  // `@RequireSectionAccess('profile:identity', 'write')`. The OR-override is
  // therefore no longer on any live code path, and two of the block's three
  // assertions necessarily invert: a grant holder whose only audience is
  // `colleague` or `self` is now `403` / `canEdit:false`, because §3.2 gives
  // both cells `R` and `docs/architecture/access-control.md:19` (NORMATIVE)
  // forbids a functional role from widening a resolved audience. That is D1
  // taking effect, not a regression — the flip restores the normative rule.
  //
  // Its intent is superseded by
  // `docs/test-cases/user-management/access-control-adoption/s41c-sag-04-functional-grant-never-widens-audience.md`,
  // asserted in `s41c-section-access-gate.e2e-spec.ts` — including the block's
  // one surviving assertion (a `'none'` target stays closed to a grant holder),
  // carried over verbatim as `s41c-sag-04` Test 5. The scenario doc is kept and
  // marked superseded, not deleted. Retirement decided 2026-09-05 by Dmytro
  // Novyk (PO), Reading 1, recorded in
  // `_bmad-output/implementation-artifacts/platform/spec-4-1c-require-section-access-gate.md`.
  //
  // The dead `user-management:edit` OR clause in `canEditS1` itself is NOT
  // deleted here — that is Story 4.2's, coupled to seating root in the
  // relationship tree.

  // docs/test-cases/user-management/access-control-adoption/umac-08-write-rejects-org-fields.md
  //
  // RED until Epic 1 Story 1.2 Stage 3. Unchanged intent under Variant A:
  // `manager` / `peoplePartner` / `department` in the PATCH body → whole request
  // `400` (§3.2 fn 1). This is `EditUserAction` / `UpdateUserDto`'s job, not the
  // guard's. Today those keys are not declared on `UpdateUserDto`, so
  // `ValidationPipe` `whitelist: true` SILENTLY STRIPS them and the request
  // `200`s on the sibling `firstName` — Story 1.2 must add explicit `@IsEmpty()`
  // rejection.
  describe('UMAC-08 · PATCH body with an organisational field is rejected 400 for every audience [RED until Story 1.2]', () => {
    // Seed a reporting-line manager over the target so the Variant A gate
    // (`canAccessSection('profile:identity') === 'write'`) passes and the request reaches the
    // DTO. §3.2 fn 1: manager / People Partner / department are read-only through
    // profile:identity for EVERY audience — they change only through Epic 4's
    // organisational-relationship screen. The rejection lives in
    // EditUserAction / UpdateUserDto, not the guard, and must be EXPLICIT (400),
    // not a silent whitelist strip.
    const rejectsOrgField = async (
      field: 'manager' | 'peoplePartner' | 'department',
    ) => {
      const manager = await fx.user(`umac08-mgr-${field}`, {
        firstName: 'Manager',
      });
      const target = await fx.user(`umac08-target-${field}`, {
        firstName: 'Original',
        position: 'Engineer',
      });
      await fx.reportsTo(target.id, manager.id);
      const bogusOrgId = '01890000-0000-7000-8000-0000000008aa';

      const res = await patch(target.id, manager.id, {
        firstName: 'Legit',
        [field]: bogusOrgId,
      });
      // RED until Story 1.2: `${field}` is not a declared UpdateUserDto property,
      // so it is silently stripped and the `firstName` change 200s.
      expect(res.status).toBe(400);

      const readBack = await getUser(target.id, manager.id);
      // The whole request is rejected — `firstName` must NOT have been applied.
      expect(readBack.body).toMatchObject({ data: { firstName: 'Original' } });

      // No org edge was created anywhere from the bogus id.
      const strayEdges = await testApp.prisma.relationship.count({
        where: { reportsToUserId: bogusOrgId },
      });
      expect(strayEdges).toBe(0);
    };

    it('UMAC-08 Test 1 — `manager` in the PATCH body → explicit 400, no field or relationship change [RED]', async () => {
      await rejectsOrgField('manager');
    });

    it('UMAC-08 Test 2a — `peoplePartner` in the PATCH body → explicit 400, no change [RED]', async () => {
      await rejectsOrgField('peoplePartner');
    });

    it('UMAC-08 Test 2b — `department` in the PATCH body → explicit 400, no change [RED]', async () => {
      await rejectsOrgField('department');
    });
  });

  // docs/test-cases/user-management/access-control-adoption/umac-09-photo-write-self-only.md
  //
  // GREEN. Photo write is Self-only via `@SelfOnly` / `SelfOnlyGuard`
  // (`viewer id == target id`) — a pure identity check. No facade call, no
  // permission key (Open Decision vi); it never consulted `user-management:edit`.
  describe('UMAC-09 · PUT /users/:id/photo is Self-only (Open Decision (v))', () => {
    it('UMAC-09 Test 2 — reporting-line manager uploads a report photo → 403', async () => {
      const manager = await fx.user('umac09-mgr', { firstName: 'Manager' });
      const target = await fx.user('umac09-target-m', { photo: null });
      await fx.reportsTo(target.id, manager.id);
      // A reporting-line manager has profile:identity `write` access to T's scalar identity
      // fields (umac-07), but photo is narrower: viewer id must equal target id.

      const res = await putPhoto(target.id, manager.id);
      expect(res.status).toBe(403);

      const row = await testApp.prisma.user.findUnique({
        where: { id: target.id },
        select: { photo: true },
      });
      expect(row?.photo).toBeNull();
    });

    it('UMAC-09 Test 3 — unrelated / colleague session uploads a photo → 403', async () => {
      const colleague = await fx.user('umac09-colleague', {
        firstName: 'Colleague',
      });
      const target = await fx.user('umac09-target-c', { photo: null });

      const res = await putPhoto(target.id, colleague.id);
      expect(res.status).toBe(403);

      const row = await testApp.prisma.user.findUnique({
        where: { id: target.id },
        select: { photo: true },
      });
      expect(row?.photo).toBeNull();
    });

    it('UMAC-09 Test 1 — Self uploads own photo → 200 with a non-null photo reference [GREEN: characterization]', async () => {
      // The allowed case (viewer id == target id). Already passes under the
      // interim adapter (Boolean(userId) === true) and must keep passing after
      // UMAC-2. Exercises the real storage adapter (LocalStack in e2e), same as
      // profile.e2e-spec.ts um-pf-02.
      const self = await fx.user('umac09-self', { photo: null });

      const res = await putPhoto(self.id, self.id);
      expect(res.status).toBe(200);
      const body = res.body as { photo?: unknown };
      expect(body.photo).toBeDefined();
      expect(body.photo).not.toBeNull();
    });
  });
});
