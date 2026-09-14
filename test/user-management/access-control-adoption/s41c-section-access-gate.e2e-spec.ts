import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { TestApp } from './fixtures';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectExactS1CardEnvelope,
  expectLeakFreeBody,
  s1CardOf,
} from './fixtures';

/**
 * PLAT-E4-S4.1c — `@RequireSectionAccess` gate + identity-card route migration
 * · AD-1 Stage 2 (red E2E, written before any implementation code).
 *
 * Scenarios (one `it` per doc Test, `s41c-sag-xx` id in the title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     s41c-sag-01-read-gate-any-audience-allows-none-denies.md
 *     s41c-sag-02-baseline-holder-without-write-audience-denied.md
 *     s41c-sag-03-write-audience-plus-baseline-allows.md
 *     s41c-sag-04-functional-grant-never-widens-audience.md
 *
 * `s41c-sag-05` (a section key absent from `SECTION_ACCESS_MATRIX` fails
 * closed) is NOT in this file. Its own Stage-2 surface section says so: 4.1c
 * wires exactly one section (`profile:identity`), so no route declares an
 * unmapped key and no HTTP request can reach that branch; inventing a test-only
 * route or overriding a UM provider to manufacture one is forbidden by
 * `testing-strategy.md`. Its evidence is the adapter unit spec
 * `src/user-management/infrastructure/__tests__/access-control-facade.adapter.spec.ts`
 * named in the story Code Map, which cannot be written yet because it calls the
 * `hasSectionAccess` port method Stage 3 introduces.
 *
 * The gate under test asks ONE question per route —
 * `hasSectionAccess(viewer, 'profile:identity', 'read' | 'write', :id)` —
 * comparing the resolved `canAccessSection` level against the requirement BY
 * RANK (`none: 0 < read: 1 < write: 2`). A `'write'` requirement is a dual gate
 * and is AUDIENCE-FIRST: the audience half denies before `isAllowed` is
 * consulted, so a functional grant can never widen a resolved audience
 * (`docs/architecture/access-control.md:19`, NORMATIVE). A `'read'` requirement
 * is audience-only — `DEFAULT_PERMISSIONS` holds no `:read` key.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Every precondition row is produced in-suite by
 * `access-control-adoption/fixtures.ts` and its id threaded from the returned
 * record — never a hardcoded id.
 */
describe('PLAT-E4-S4.1c Stage 2 — section-access gate on GET / PATCH /users/:id (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const getUser = (targetId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  const patch = (
    targetId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(testApp.app.getHttpServer())
      .patch(`/users/${targetId}`)
      .set('authorization', bearer(viewerId))
      .send(body);

  /** Read a persisted column straight from the database (never inferred from a status code). */
  const cityOf = async (userId: string): Promise<string | null | undefined> => {
    const row = await testApp.prisma.user.findUnique({
      where: { id: userId },
      select: { city: true },
    });
    return row?.city;
  };

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

  // docs/test-cases/user-management/access-control-adoption/
  //   s41c-sag-01-read-gate-any-audience-allows-none-denies.md
  //
  // `GET /users/:id` declares `@RequireSectionAccess('profile:identity','read')`.
  // Every §3.2 S1 cell is at least `R`, so ANY non-empty audience reaches rank
  // >= 1 and reads the card; an empty audience resolves `'none'` (rank 0) and
  // denies. No `UserPolicies` / `Policies` / `PolicyPermissions` row is created
  // anywhere in this block — the read gate must not depend on one.
  describe('s41c-sag-01 · read gate — any non-empty audience allows, `none` denies', () => {
    it('s41c-sag-01 Test 1 · self (§3.2 S1 Self = R) → 200, exactly the 12-key card, canEdit false', async () => {
      const viewer = await fx.user('sag01-viewer');

      const res = await getUser(viewer.id, viewer.id);

      expect(res.status).toBe(200);
      // `self` resolves `read` (rank 1) — it satisfies the `'read'` requirement
      // but not the `'write'` question the `canEdit` hint asks (s41c-sag-02).
      expectExactS1CardEnvelope(res.body, s1CardOf(viewer), false);
    });

    it('s41c-sag-01 Test 2 · colleague, no Relationship edge (§3.2 S1 Colleague = R) → 200, same field set', async () => {
      const viewer = await fx.user('sag01-viewer');
      const target = await fx.user('sag01-target');
      // No Relationship row in either direction and V !== T → the `colleague`
      // floor only, which §3.2 gives `R`.

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
    });

    it('s41c-sag-01 Test 3 · reporting-line manager (§3.2 S1 Reporting line = RW) → 200 — `write` satisfies a `read` requirement', async () => {
      const viewer = await fx.user('sag01-viewer');
      const target = await fx.user('sag01-target');
      // Real `Relationship { userId: T, type: 'direct', reportsToUserId: V }`.
      await fx.reportsTo(target.id, viewer.id);

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      // Resolved level `write` (rank 2) against a `'read'` requirement (rank 1):
      // the allow proves the comparison is by rank, not by equality.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), true);
    });

    it('s41c-sag-01 Test 4 · assigned People Partner (§3.2 S1 PP = RW) → 200, same field set', async () => {
      const viewer = await fx.user('sag01-viewer');
      const target = await fx.user('sag01-target');
      // Real `Relationship { userId: T, type: 'people_partner', reportsToUserId: V }`.
      await fx.peoplePartnerOf(target.id, viewer.id);

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      expectExactS1CardEnvelope(res.body, s1CardOf(target), true);
    });

    // SUPERSEDED 2026-09-12 by umac-11 (PM/AD-24, CONFLICT-UM-01): a hidden
    // target is `404`, decided before the section check. Was `403`.
    it('s41c-sag-01 Test 5 · deactivated target → 404, leak-free body (umac-11)', async () => {
      const viewer = await fx.user('sag01-viewer');
      const target = await fx.user('sag01-inactive-target', {
        isActive: false,
      });
      // T is not an active `User` → hidden target → `SectionAccessGuard`
      // answers `404` before `hasSectionAccess` is asked.

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(404);
      expectLeakFreeBody(res.body, target);
    });

    // SUPERSEDED 2026-09-12 by umac-11 (PM/AD-24, CONFLICT-UM-01). Was `403`.
    it('s41c-sag-01 Test 6 · unknown target id → 404, leak-free body (umac-11)', async () => {
      const viewer = await fx.user('sag01-viewer');
      // A freshly generated, well-formed id that matches no row.
      const unknownTargetId = uuidv7();

      const res = await getUser(unknownTargetId, viewer.id);

      // The 2026-09-01 empty-audience 403 decision is superseded by PM/AD-24.
      expect(res.status).toBe(404);
      expectLeakFreeBody(res.body);
    });
  });

  // docs/test-cases/user-management/access-control-adoption/
  //   s41c-sag-02-baseline-holder-without-write-audience-denied.md
  //
  // `PATCH /users/:id` declares `@RequireSectionAccess('profile:identity','write')`.
  // Every viewer here is an active user, so every viewer HOLDS the feature half
  // (`profile:identity:write` via `DEFAULT_PERMISSIONS`, no `UserPolicies` row)
  // — and is still denied, because the audience half resolves `read` first and
  // short-circuits. Holding the baseline is necessary, never sufficient. No
  // `fx.grantFunctionalRole(...)` call may appear in this block: an explicit
  // grant chain would confound the claim.
  describe('s41c-sag-02 · the `profile:identity:write` baseline alone is not enough — a `read` audience is denied', () => {
    it('s41c-sag-02 Test 1 · colleague holding the baseline PATCHes → 403, row unchanged', async () => {
      const viewer = await fx.user('sag02-viewer');
      const target = await fx.user('sag02-target', { city: 'Krakow' });
      // No Relationship edge either direction → `colleague` only → `read`.

      const res = await patch(target.id, viewer.id, { city: 'Berlin' });

      expect(res.status).toBe(403);
      // Asserted against the database, not inferred from the status code.
      await expect(cityOf(target.id)).resolves.toBe('Krakow');
    });

    it('s41c-sag-02 Test 2 · the same viewer’s canEdit hint is false', async () => {
      const viewer = await fx.user('sag02-viewer');
      const target = await fx.user('sag02-target', { city: 'Krakow' });

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      // Same question as Test 1 (`hasSectionAccess(V,'profile:identity','write',T)`),
      // answered on a route that is not gated by it.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
      expect((res.body as { data: { city: string } }).data.city).toBe('Krakow');
    });

    it('s41c-sag-02 Test 3 · self PATCHes a non-photo S1 field → 403, own row unchanged', async () => {
      const viewer = await fx.user('sag02-viewer', { city: 'Krakow' });
      // §3.2 S1 gives Self `R`; the photo is the only Self-writable element and
      // travels on `PUT /users/:id/photo` (umac-09), untouched by this story.

      const res = await patch(viewer.id, viewer.id, { city: 'Gdansk' });

      expect(res.status).toBe(403);
      await expect(cityOf(viewer.id)).resolves.toBe('Krakow');
    });

    it('s41c-sag-02 Test 4 · self’s own canEdit hint is false', async () => {
      const viewer = await fx.user('sag02-viewer', { city: 'Krakow' });
      // A person is never their own reporting-line manager or assigned People
      // Partner, so this never flips.

      const res = await getUser(viewer.id, viewer.id);

      expect(res.status).toBe(200);
      expectExactS1CardEnvelope(res.body, s1CardOf(viewer), false);
    });
  });

  // docs/test-cases/user-management/access-control-adoption/
  //   s41c-sag-03-write-audience-plus-baseline-allows.md
  //
  // Both halves hold, in this order: `canAccessSection` → 'write' (rank 2 >= 2),
  // THEN `isAllowed(V,'profile:identity:write')` → true from the code-owned
  // `DEFAULT_PERMISSIONS` baseline — with NO `Policies` / `PolicyPermissions` /
  // `UserPolicies` row anywhere in the fixture. That absence is the point.
  describe('s41c-sag-03 · a `write` audience plus the `profile:identity:write` baseline allows the edit', () => {
    it('s41c-sag-03 Test 1 · reporting-line manager → 200, the change persists', async () => {
      const manager = await fx.user('sag03-manager');
      const target = await fx.user('sag03-report', {
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
      });
      await fx.reportsTo(target.id, manager.id);

      const res = await patch(target.id, manager.id, {
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });

      expect(res.status).toBe(200);
      // The PATCH body is the plain `toUserResponse` shape, not the read envelope.
      expect(res.body).toMatchObject({
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });
    });

    it('s41c-sag-03 Test 2 · observing the change, and the hint → 200, exactly the 12-key card, canEdit true', async () => {
      const manager = await fx.user('sag03-manager');
      const target = await fx.user('sag03-report', {
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
      });
      await fx.reportsTo(target.id, manager.id);

      const patched = await patch(target.id, manager.id, {
        position: 'Senior Engineer',
        country: 'DE',
        city: 'Berlin',
        workPhone: '+49 30 000000',
      });
      expect(patched.status).toBe(200);

      const res = await getUser(target.id, manager.id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: {
          position: 'Senior Engineer',
          country: 'DE',
          city: 'Berlin',
          workPhone: '+49 30 000000',
        },
        canEdit: true,
      });
      // `data` carries exactly the 12 S1-card keys, matching the persisted row.
      const persisted = await testApp.prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expectExactS1CardEnvelope(res.body, s1CardOf(persisted), true);
    });

    it('s41c-sag-03 Test 3 · assigned People Partner → 200, the change persists', async () => {
      const pp = await fx.user('sag03-pp');
      const employee = await fx.user('sag03-employee', { city: 'Krakow' });
      await fx.peoplePartnerOf(employee.id, pp.id);

      const res = await patch(employee.id, pp.id, { city: 'Berlin' });
      expect(res.status).toBe(200);

      const readBack = await getUser(employee.id, pp.id);
      expect(readBack.status).toBe(200);
      expect(readBack.body).toMatchObject({
        data: { city: 'Berlin' },
        canEdit: true,
      });
      await expect(cityOf(employee.id)).resolves.toBe('Berlin');
    });

    it('s41c-sag-03 Test 4 · transitive reporting line (T → M → V) → 200', async () => {
      const viewer = await fx.user('sag03-skip-manager');
      const middle = await fx.user('sag03-mid-manager');
      const target = await fx.user('sag03-deep-report', { city: 'Krakow' });
      // Two `direct` edges: V sits two hops up T's reporting chain. The
      // `reporting` audience is the transitive walk, so the gate allows a
      // grand-manager exactly as it allows a direct one — no extra decorator,
      // no extra branch.
      await fx.reportsTo(target.id, middle.id);
      await fx.reportsTo(middle.id, viewer.id);

      const res = await patch(target.id, viewer.id, { city: 'Berlin' });
      expect(res.status).toBe(200);

      const readBack = await getUser(target.id, viewer.id);
      expect(readBack.status).toBe(200);
      expect(readBack.body).toMatchObject({
        data: { city: 'Berlin' },
        canEdit: true,
      });
    });
  });

  // docs/test-cases/user-management/access-control-adoption/
  //   s41c-sag-04-functional-grant-never-widens-audience.md
  //
  // The NORMATIVE invariant at `docs/architecture/access-control.md:19` — "a new
  // functional role never widens data access ... feature permissions operate
  // WITHIN the holder's resolved audiences only". The grant is a real
  // `Policy(type='FR')` → `PolicyPermission` → `Permission` → `UserPolicy`
  // chain, resolved by `isAllowed` like any other grant.
  //
  // This block deliberately asserts the OPPOSITE of `umac-10`, which ratified
  // the interim `user-management:edit` OR-override in `canEditS1`. That
  // scenario doc is superseded by `s41c-sag-04`; retiring its describe block in
  // `write-adoption.e2e-spec.ts` is Stage 3's job, not Stage 2's.
  //
  // STAGE-2 EXPECTATION: Tests 1-3 are RED — today's `canEditS1` reaches
  // `isAllowed(viewer, 'user-management:edit')` after a `'read'` section result
  // and lets the grant win. Tests 4 and 5 are expected green before and after.
  describe('s41c-sag-04 · a live functional-role grant never widens a resolved audience', () => {
    it('s41c-sag-04 Test 1 · grant holder, colleague audience, active target → 403, row unchanged [RED until Stage 3]', async () => {
      const editor = await fx.user('sag04-editor');
      const target = await fx.user('sag04-target', { city: 'Krakow' });
      // No Relationship edge either direction → E is only `colleague` over T →
      // `canAccessSection` → 'read', rank 1 < 2 → deny BEFORE the functional
      // half is consulted.
      await fx.grantFunctionalRole(editor.id, ['user-management:edit']);

      const res = await patch(target.id, editor.id, { city: 'Berlin' });

      expect(res.status).toBe(403);
      await expect(cityOf(target.id)).resolves.toBe('Krakow');
    });

    it('s41c-sag-04 Test 2 · the same grant holder’s canEdit hint is false [RED until Stage 3]', async () => {
      const editor = await fx.user('sag04-editor');
      const target = await fx.user('sag04-target', { city: 'Krakow' });
      await fx.grantFunctionalRole(editor.id, ['user-management:edit']);

      const res = await getUser(target.id, editor.id);

      expect(res.status).toBe(200);
      // The grant cannot make the hint disagree with the gate — both are the
      // same `hasSectionAccess(...,'write',...)` call.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
      expect((res.body as { data: { city: string } }).data.city).toBe('Krakow');
    });

    it('s41c-sag-04 Test 3 · grant holder edits their OWN card → 403 [RED until Stage 3]', async () => {
      const editor = await fx.user('sag04-editor', { city: 'Krakow' });
      await fx.grantFunctionalRole(editor.id, ['user-management:edit']);
      // §3.2 S1 gives Self `R`; a functional grant does not turn that cell into
      // `RW`. (Under the interim override this returned 200 — umac-10 Test 2.)

      const res = await patch(editor.id, editor.id, { city: 'Gdansk' });

      expect(res.status).toBe(403);
      await expect(cityOf(editor.id)).resolves.toBe('Krakow');
    });

    it('s41c-sag-04 Test 4 · a grant of the dual gate’s OWN feature key still does not widen → 403', async () => {
      const editor = await fx.user('sag04-key-editor');
      const target = await fx.user('sag04-key-target', { city: 'Krakow' });
      // The strongest form of the invariant: E2 holds `profile:identity:write`
      // EXPLICITLY — the exact key the dual gate's feature half consults — on
      // top of holding it implicitly through `DEFAULT_PERMISSIONS`, and still
      // has no audience. The feature half can only ever subtract.
      await fx.grantFunctionalRole(editor.id, ['profile:identity:write']);

      const res = await patch(target.id, editor.id, { city: 'Berlin' });

      expect(res.status).toBe(403);
      await expect(cityOf(target.id)).resolves.toBe('Krakow');
    });

    // Status code SUPERSEDED 2026-09-12 by umac-11 (PM/AD-24, CONFLICT-UM-01):
    // an inactive target is a hidden target → `404`, before the section check.
    // The claim under test is unchanged: the grant opens nothing, row untouched.
    it('s41c-sag-04 Test 5 · a `none` (inactive) target stays closed to a grant holder → 404, row unchanged (umac-11)', async () => {
      const editor = await fx.user('sag04-editor');
      const target = await fx.user('sag04-inactive-target', {
        city: 'Krakow',
        isActive: false,
      });
      await fx.grantFunctionalRole(editor.id, ['user-management:edit']);
      // Not an active `User` → hidden target → `404` before any section or
      // feature question, so the grant is never consulted.

      const res = await patch(target.id, editor.id, { city: 'Berlin' });

      expect(res.status).toBe(404);
      await expect(cityOf(target.id)).resolves.toBe('Krakow');
    });
  });
});
