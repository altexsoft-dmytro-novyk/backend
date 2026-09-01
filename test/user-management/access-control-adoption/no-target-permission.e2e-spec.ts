import request from 'supertest';
import type { TestApp } from './fixtures';
import { RunFixtures, bearer, bootstrapTestApp } from './fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1) · AD-1 Stage 2,
 * committed red.
 *
 * Scenario: docs/test-cases/user-management/access-control-adoption/
 *   umac-06-no-target-isallowed-delegates-to-facade.md
 *
 * The real adapter's `isAllowed(userId, feature)` delegates straight to
 * `AccessControlFacade.isAllowed`; the interim adapter's
 * `actor.position === 'HR Admin'` string check is deleted. The three no-target
 * routes — `GET /users` (`user-management:list`), `POST /users`
 * (`user-management:create`), `DELETE /users/:id` (`user-management:deactivate`)
 * — are exactly the ACM-1 seeded grant set, so a real `hr-admin` FR grant keeps
 * them working and any other session fails closed.
 *
 * WHY RED / GREEN (per test):
 *   - Test 1 (seeded hr-admin root, real FR grant) — **already-green
 *     characterization.** The interim adapter allows it via the
 *     `position === 'HR Admin'` check; the real facade allows it via the live
 *     FR grant chain. Kept (not skipped) so the delegated allow path stays
 *     covered.
 *   - Test 2 (unrelated active user, ordinary position, no FR grant) —
 *     **already-green characterization.** Interim: `position !== 'HR Admin'` →
 *     `403`. Real facade: no grant → `403`.
 *   - Test 3 (Ida — holds an unrelated FR permission, not these three) —
 *     **already-green characterization.** Interim denies on position; the real
 *     facade denies because holding *a* permission is not holding *this* one
 *     (DEC-UM-002).
 *   - Test 4 (impostor — `User.position = 'HR Admin'` but NO FR grant) —
 *     **RED (red-because-not-implemented).** This is the assertion that makes
 *     UMAC-06 a committed-red test: the interim adapter ALLOWS it (the
 *     prohibited role-name check — `access-control.md:49` / AD-4), so
 *     `GET /users` returns `200`, `POST /users` `201`, `DELETE /users/:id`
 *     `200`. The scenario's target is `403` on all three ("the facade ...
 *     never compares a role name or `User.position`"). Goes green when
 *     `UMAC-1-production` deletes the interim adapter and delegates `isAllowed`
 *     to the facade.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. The FR grant chain is seeded in-suite (mirrors
 * acm2-is-allowed.e2e-spec.ts) rather than assumed from a prior bootstrap.
 */
describe('UMAC-1 Stage 2 — UMAC-06 no-target isAllowed delegates to the real facade (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const createUserBody = (persona: string) => ({
    firstName: 'Created',
    lastName: 'ByRoot',
    position: 'Engineer',
    country: 'PL',
    city: 'Krakow',
    workEmail: fx.emailFor(persona),
    companyJoinDate: '2024-01-01',
  });

  const listUsers = (viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get('/users')
      .set('authorization', bearer(viewerId));

  const createUser = (viewerId: string, persona: string) =>
    request(testApp.app.getHttpServer())
      .post('/users')
      .set('authorization', bearer(viewerId))
      .send(createUserBody(persona));

  // If the interim adapter wrongly lets a create through, the row is real —
  // track it so teardown removes it (belt-and-suspenders cleanup also sweeps
  // by the run namespace).
  const trackCreated = (body: unknown): void => {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id === 'string') {
      fx.userIds.add(id);
    }
  };

  const deactivateUser = (viewerId: string, targetId: string) =>
    request(testApp.app.getHttpServer())
      .delete(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

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

  it('UMAC-06 Test 1 — seeded hr-admin root is allowed on list / create / deactivate (already-green characterization)', async () => {
    const root = await fx.user('umac06-root', { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id);
    const deactivationTarget = await fx.user('umac06-target1');

    const list = await listUsers(root.id);
    expect(list.status).toBe(200);

    const create = await createUser(root.id, 'umac06-created-1');
    expect(create.status).toBe(201);
    trackCreated(create.body);

    const deactivate = await deactivateUser(root.id, deactivationTarget.id);
    expect(deactivate.status).toBe(200);
  });

  it('UMAC-06 Test 2 — unrelated active user with no FR grant is denied 403 on all three (already-green characterization)', async () => {
    const unrelated = await fx.user('umac06-unrelated', {
      position: 'Engineer',
    });
    const target = await fx.user('umac06-target2');

    expect((await listUsers(unrelated.id)).status).toBe(403);
    expect((await createUser(unrelated.id, 'umac06-created-2')).status).toBe(
      403,
    );
    expect((await deactivateUser(unrelated.id, target.id)).status).toBe(403);
  });

  it('UMAC-06 Test 3 — Ida holds an unrelated FR permission, not these three → 403 (already-green characterization, DEC-UM-002)', async () => {
    const ida = await fx.user('umac06-ida', { position: 'Engineer' });
    // A real FR grant chain for a DIFFERENT permission key.
    await fx.grantFunctionalRole(ida.id, [`umac06:unrelated-${fx.runId}`]);
    const target = await fx.user('umac06-target3');

    expect((await listUsers(ida.id)).status).toBe(403);
    expect((await createUser(ida.id, 'umac06-created-3')).status).toBe(403);
    expect((await deactivateUser(ida.id, target.id)).status).toBe(403);
  });

  it('UMAC-06 Test 4 — impostor with User.position = "HR Admin" but NO FR grant → 403 on all three (RED)', async () => {
    // The interim adapter ALLOWS this via the prohibited `position === "HR Admin"`
    // role-name check; the real facade denies it because no FR grant chain
    // exists. This is the committed-red heart of UMAC-06.
    const impostor = await fx.user('umac06-impostor', { position: 'HR Admin' });
    const target = await fx.user('umac06-target4');

    const list = await listUsers(impostor.id);
    expect(list.status).toBe(403);

    const create = await createUser(impostor.id, 'umac06-created-4');
    trackCreated(create.body);
    expect(create.status).toBe(403);

    const deactivate = await deactivateUser(impostor.id, target.id);
    expect(deactivate.status).toBe(403);
  });
});
