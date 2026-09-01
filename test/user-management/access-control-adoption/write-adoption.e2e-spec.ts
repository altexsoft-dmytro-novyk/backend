import request from 'supertest';
import type { TestApp } from './fixtures';
import { RunFixtures, bearer, bootstrapTestApp } from './fixtures';

/**
 * ============================================================================
 * DEFERRED — implemented later. This suite belongs to Story 0.2 (UMAC-2), the
 * write path, NOT to Story 0.1 (UMAC-1) which is read-only. UMAC-2 has no
 * Stage-1 approval yet and is blocked on Open Decision (i) = option (a): the
 * `user-management:edit` permission does not exist in the kernel catalog, and
 * adding it is a separate three-stage AD-1 kernel-seed sequence that has not
 * started. The one positive test here (a granted reporting-line manager
 * PATCHes S1) also assumes a not-yet-approved product rule (managers get
 * `user-management:edit` by default). Kept in the tree per the owner's
 * instruction (2026-09-01); it will be re-derived / activated by the UMAC-2
 * Stage-2 dispatch once UMAC-2 Stage 1 is approved and the permission is
 * seeded. Do not treat its state as UMAC-1 evidence.
 * ============================================================================
 *
 * Epic 0 — Access Control Adoption · Story 0.2 (UMAC-2) · AD-1 Stage 2.
 *
 * Scenarios (one E2E per assertion, `UMAC-xx` id in the test title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     umac-07-write-dual-gate.md
 *     umac-08-write-rejects-org-fields.md
 *     umac-09-photo-write-self-only.md
 *
 * OPEN DECISION (i). No `user-management:edit` / photo permission is in the
 * seeded kernel catalog (create / deactivate / list only, per
 * services/backend/src/access-control/infrastructure/bootstrap/access-control-bootstrap.ts
 * CANONICAL_PERMISSIONS). Every test here still runs as a real `it()`:
 *   - the negatives (UMAC-07 section-half / UMAC-08 org-field / UMAC-09
 *     Self-only) do not depend on that permission at all;
 *   - the ONE positive (UMAC-07 Test 1 — a granted reporting-line manager
 *     PATCHes a report’s S1 → 200) SEEDS the `user-management:edit` grant
 *     itself (a real FR Policy + Permission + PolicyPermission + UserPolicy
 *     chain), assuming Open Decision (i) resolves to that permission being
 *     granted to reporting-line managers by default. It is green-via-interim
 *     today (wrong reason) and stays green once UMAC-2 wires the real dual gate.
 *
 * Everything in this file is a REAL committed-red (or forward) assertion — the
 * security-critical negatives:
 *   - the SECTION half of the dual gate denies a colleague / self / unresolved
 *     PATCH regardless of any functional permission (UMAC-07);
 *   - `EditUserAction` / `UpdateUserDto` reject an organisational field in the
 *     PATCH body for every audience (UMAC-08, §3.2 fn 1);
 *   - photo write is Self-only — an identity-equality command rule, no
 *     permission involved (UMAC-09).
 *
 * WHY RED (per test): today `user-management.module.ts` binds
 * `ACCESS_CONTROL_PORT` to `InterimAccessControlAdapter`, whose
 * `isAllowedForTarget` returns `Boolean(userId)` — it ignores the feature, the
 * section, and identity. So `PATCH /users/:id` and `PUT /users/:id/photo`
 * succeed for every resolvable session. Each negative below asserts the
 * post-`UMAC-2` behaviour and fails against the interim adapter. Marked per
 * test. `UMAC-08` is additionally red because `UpdateUserDto` does not declare
 * `manager` / `peoplePartner` / `department`, so `ValidationPipe`
 * `whitelist: true` SILENTLY STRIPS them and the request 200s (E2E audit §2) —
 * `UMAC-2` production must add explicit `@IsEmpty()` rejection.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` rows and issue
 * `Bearer <token:<seeded-uuid>>`.
 */
describe('UMAC-2 Stage 2 (partial red) — PATCH / PUT photo write-path gates (e2e)', () => {
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
  describe('UMAC-07 · PATCH /users/:id is behind the §2.2 dual gate', () => {
    it('UMAC-07 Test 3 — colleague (no reporting/PP edge) PATCH S1 → 403 [RED: section half fails, canAccessSection = "read"]', async () => {
      const viewer = await fx.user('umac07-colleague', {
        firstName: 'Colleague',
      });
      const target = await fx.user('umac07-target-c', { position: 'Engineer' });
      // No Relationship edge either direction → V is only `colleague` over T →
      // canAccessSection(V, 'S1', T) === 'read', not 'write' → dual gate fails.

      const res = await patch(target.id, viewer.id, {
        position: 'Principal Engineer',
      });
      expect(res.status).toBe(403);

      const readBack = await getUser(target.id, viewer.id);
      expect(readBack.body).toMatchObject({ position: 'Engineer' });
    });

    it('UMAC-07 Test 4 — Self PATCH of a non-photo S1 field → 403 [RED: S1 is "read" for self; only the photo is Self-writable]', async () => {
      const self = await fx.user('umac07-self', { position: 'Engineer' });
      // §3.2: the S1 identity card is `R` for Self; a manager-line / PP audience
      // is required to WRITE S1. Self writes only the photo (umac-09).

      const res = await patch(self.id, self.id, { position: 'Staff Engineer' });
      expect(res.status).toBe(403);

      const readBack = await getUser(self.id, self.id);
      expect(readBack.body).toMatchObject({ position: 'Engineer' });
    });

    it('UMAC-07 Test 5 — unresolved session (Bearer <token:Bob>) PATCH → 403 [RED]', async () => {
      const target = await fx.user('umac07-target-u', { position: 'Engineer' });
      // `Bearer <token:Bob>` → { userId: 'Bob' } → no active User → empty
      // audience → both halves of the dual gate fail. Write-path denial stays
      // 403 (a valid token with no write entitlement), not the read 404.

      const res = await request(testApp.app.getHttpServer())
        .patch(`/users/${target.id}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ position: 'Ghost Engineer' });
      expect(res.status).toBe(403);
    });

    it('UMAC-07 Test 1 — reporting-line manager holding user-management:edit PATCHes a report’s S1 → 200 [forward test]', async () => {
      // ASSUMES Open Decision (i) resolves to a seeded `user-management:edit`
      // permission granted to reporting-line managers by default; the fixture
      // creates that grant (a real FR Policy + Permission{key:'user-management:edit'}
      // + PolicyPermission + UserPolicy attachment to the manager — same chain
      // no-target-permission.e2e-spec.ts builds for UMAC-06) so the assertion is
      // meaningful rather than a placeholder.
      //
      // GREEN-via-interim today, for the WRONG reason: `isAllowedForTarget`
      // returns `Boolean(userId)` and ignores both halves of the dual gate.
      // Stays green after UMAC-2 wires the real dual gate, which then actually
      // consults `isAllowed(V, 'user-management:edit') === true` (this grant)
      // AND `canAccessSection(V, 'S1', T) === 'write'` (the reporting edge).
      const manager = await fx.user('umac07-mgr', { firstName: 'Manager' });
      const alice = await fx.user('umac07-alice', {
        firstName: 'Alice',
        position: 'Engineer',
      });
      await fx.reportsTo(alice.id, manager.id);
      await fx.grantFunctionalRole(manager.id, ['user-management:edit']);

      const res = await patch(alice.id, manager.id, {
        position: 'Senior Engineer',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ position: 'Senior Engineer' });

      const readBack = await getUser(alice.id, manager.id);
      expect(readBack.body).toMatchObject({ position: 'Senior Engineer' });
    });
  });

  // docs/test-cases/user-management/access-control-adoption/umac-08-write-rejects-org-fields.md
  describe('UMAC-08 · PATCH body with an organisational field is rejected 400 for every audience', () => {
    // Seed a reporting-line manager over the target so the request is otherwise
    // as authorized as it can be pre-permission (and the interim adapter allows
    // it regardless). §3.2 fn 1: manager / People Partner / department are
    // read-only through S1 for EVERY audience — they change only through Epic 4's
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
      // RED today: `${field}` is not a declared UpdateUserDto property, so it is
      // silently stripped and the `firstName` change 200s.
      expect(res.status).toBe(400);

      const readBack = await getUser(target.id, manager.id);
      // The whole request is rejected — `firstName` must NOT have been applied.
      expect(readBack.body).toMatchObject({ firstName: 'Original' });

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
  describe('UMAC-09 · PUT /users/:id/photo is Self-only (Open Decision (v): Self-only recommended)', () => {
    it('UMAC-09 Test 2 — reporting-line manager uploads a report photo → 403 [RED]', async () => {
      const manager = await fx.user('umac09-mgr', { firstName: 'Manager' });
      const target = await fx.user('umac09-target-m', { photo: null });
      await fx.reportsTo(target.id, manager.id);
      // A reporting-line manager may write other S1 fields on T via the umac-07
      // dual gate, but photo is narrower: viewer id must equal target id.

      const res = await putPhoto(target.id, manager.id);
      expect(res.status).toBe(403);

      const row = await testApp.prisma.user.findUnique({
        where: { id: target.id },
        select: { photo: true },
      });
      expect(row?.photo).toBeNull();
    });

    it('UMAC-09 Test 3 — unrelated / colleague session uploads a photo → 403 [RED]', async () => {
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
