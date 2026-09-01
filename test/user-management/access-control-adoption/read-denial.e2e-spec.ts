import request from 'supertest';
import type { TestApp } from './fixtures';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectLeakFreeBody,
} from './fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1) · AD-1 Stage 2,
 * committed red.
 *
 * Scenario: docs/test-cases/user-management/access-control-adoption/
 *   umac-05-unresolved-session-read-denied.md
 *
 * The ONLY `GET /users/:id` denial is a genuinely unresolvable identity — the
 * viewer (or target) is not an active `User`, so
 * `AccessControlFacade.resolveAudiences` returns an empty `Set`: the viewer is
 * never Self and never even the Colleague floor. The scenario's stated target
 * is a leak-free `404`.
 *
 * WHY RED (per test):
 *   - Test 1 (`Bearer <token:Bob>` literal) — **red-because-not-implemented
 *     (empty-audience denial).** The interim adapter's
 *     `isAllowedForTarget` returns `Boolean('Bob') === true`, so the guard lets
 *     the request through and `GET /users/:id` returns `200` with the whole
 *     row. Asserting `404` fails until `UMAC-1-production` lands.
 *   - Test 2 (deactivated caller) — **red-because-not-implemented.** Same
 *     mechanism: `Boolean(<uuid>) === true` under the interim adapter → `200`.
 *     Under the real facade the identity port filters `isActive = true`, so the
 *     viewer is unconfirmed → empty audience → deny.
 *   - Test 3 (non-existent target, valid active caller) — **already-green
 *     characterization.** The interim guard lets the caller through, then
 *     `GetUserAction` throws `NotFoundException` because the row is missing →
 *     `404` today. Under the real facade the empty audience denies and the
 *     scenario also maps that to `404`. Marked green; kept (not skipped) so the
 *     leak-free-body contract stays covered.
 *
 * MECHANISM NOTE (scenario "Mechanism — open for the scenario stage"):
 * `AccessControlGuard` currently maps a denied `isAllowedForTarget` to
 * `ForbiddenException` → `403`. The scenario's target `404` needs the read
 * action / controller to treat an empty audience (or missing target) as
 * `NotFound`; `UMAC-1-production`'s `invoke_dev_with` states that as the
 * production intent ("mapped to a leak-free 404 (not 403) ... the read action
 * treats an empty audience / missing target as NotFound"). The primary
 * assertion below therefore follows the scenario: `404`.
 * TODO(UMAC-1-production): if a shipped Story 0.1 leaves `AccessControlGuard`
 * unchanged, an unresolved-identity denial surfaces as `403` — the documented
 * fallback, not the target. Confirm 404 vs 403 at the production stage.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides.
 */
describe('UMAC-1 Stage 2 (red) — GET /users/:id empty-audience denial is a leak-free 404 (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

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

  // docs/test-cases/user-management/access-control-adoption/umac-05-unresolved-session-read-denied.md
  it('UMAC-05 Test 1 — literal placeholder id (Bearer <token:Bob>) → leak-free 404', async () => {
    const target = await fx.user('umac05-target', { firstName: 'Target' });

    // `Bearer <token:Bob>` resolves through InterimSessionResolverAdapter to
    // `{ userId: 'Bob' }` — the string id 'Bob', which matches no active User.
    // This is the exact case the E2E audit says "passes" under the interim
    // adapter (`Boolean('Bob') === true` → 200) and must fail under the real
    // facade.
    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', 'Bearer <token:Bob>');

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body, target);
  });

  it('UMAC-05 Test 2 — deactivated caller (isActive: false) → leak-free 404', async () => {
    const target = await fx.user('umac05-target2', { firstName: 'Target' });
    const deactivatedCaller = await fx.user('umac05-deactivated', {
      firstName: 'Deactivated',
      isActive: false,
    });

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', bearer(deactivatedCaller.id));

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body, target);
  });

  it('UMAC-05 Test 3 — non-existent target, valid active caller → leak-free 404 (already-green characterization)', async () => {
    const caller = await fx.user('umac05-caller', { firstName: 'Caller' });
    // A well-formed id that resolves to no `User` row.
    const missingTargetId = '01890000-0000-7000-8000-0000000000ff';

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${missingTargetId}`)
      .set('authorization', bearer(caller.id));

    expect(res.status).toBe(404);
    expectLeakFreeBody(res.body);
  });
});
