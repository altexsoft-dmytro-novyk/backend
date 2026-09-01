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
 * `GET /users/:id` has TWO denial shapes and NO `404` authorization branch (the
 * earlier "leak-free 404" convention was withdrawn by human product decision on
 * 2026-09-01 — this is an internal employee directory, standard REST codes are
 * clearer):
 *   - an unresolved session (no/invalid token, a literal persona placeholder,
 *     or a deactivated caller) is the SESSION layer's responsibility → `401`
 *     once the Epic 2 magic-link middleware lands. `InterimSessionResolverAdapter`
 *     is lax (it parses the token into `{ userId: <string> }` without checking
 *     the row exists or is active), so during the interim such a request reaches
 *     `AccessControlGuard`, resolves to an empty audience, and surfaces as
 *     `403`. That interim `403` is what this suite asserts — NOT `401`.
 *   - an authenticated ACTIVE viewer whose audience over the target is empty
 *     (on this read route `colleague` is the floor, so this means the target is
 *     not an active `User`) → `403`. No existence distinction: a forbidden
 *     target and a missing target both return `403`. This is exactly what
 *     `AccessControlGuard` produces today from a denied `isAllowedForTarget`, so
 *     no guard or controller change is in scope for this story.
 *
 * WHY RED (per test):
 *   - Test 1 (`Bearer <token:Bob>` literal) — **red-because-not-implemented
 *     (empty-audience denial).** The interim access-control adapter's
 *     `isAllowedForTarget` returns `Boolean('Bob') === true`, so the guard lets
 *     the request through and `GET /users/:id` returns `200` with the whole
 *     row. Asserting `403` fails until `UMAC-1-production` rebinds the port to
 *     the real facade (unconfirmed viewer → empty audience → deny).
 *   - Test 2 (deactivated caller) — **red-because-not-implemented.** Same
 *     mechanism: `Boolean(<uuid>) === true` under the interim adapter → `200`.
 *     Under the real facade the identity port filters `isActive = true`, so the
 *     viewer is unconfirmed → empty audience → deny → `403`.
 *   - Test 3 (non-existent target, valid active caller) — **red-because-not-
 *     implemented.** The interim guard lets the caller through, then
 *     `GetUserAction` throws `NotFoundException` because the row is missing →
 *     `404` today. The approved scenario requires `403` (no existence
 *     distinction); under the real facade the empty audience denies with `403`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides.
 */
describe('UMAC-1 Stage 2 (red) — GET /users/:id denials are 403 (never 404) (e2e)', () => {
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
  it('UMAC-05 Test 1 — literal placeholder id (Bearer <token:Bob>) → 403 denial (leak-free body)', async () => {
    const target = await fx.user('umac05-target', { firstName: 'Target' });

    // `Bearer <token:Bob>` resolves through InterimSessionResolverAdapter to
    // `{ userId: 'Bob' }` — the string id 'Bob', which matches no active User.
    // This is the exact case that "passes" under the interim access-control
    // adapter (`Boolean('Bob') === true` → 200) and must be denied under the
    // real facade.
    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', 'Bearer <token:Bob>');

    // Interim session resolver is lax → the guard denies the empty audience →
    // `403`. TARGET END STATE once the real magic-link middleware lands: `401`
    // (the session never resolves). Do NOT assert `401` here.
    expect(res.status).toBe(403);
    expectLeakFreeBody(res.body, target);
  });

  it('UMAC-05 Test 2 — deactivated caller (isActive: false) → 403 denial (leak-free body)', async () => {
    const target = await fx.user('umac05-target2', { firstName: 'Target' });
    const deactivatedCaller = await fx.user('umac05-deactivated', {
      firstName: 'Deactivated',
      isActive: false,
    });

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', bearer(deactivatedCaller.id));

    // Kernel MVP runtime eligibility includes `User.isActive`, so an inactive
    // viewer resolves to an empty audience → the guard denies → `403`. TARGET
    // END STATE once the real magic-link middleware lands: `401`. Do NOT assert
    // `401` here.
    expect(res.status).toBe(403);
    expectLeakFreeBody(res.body, target);
  });

  it('UMAC-05 Test 3 — non-existent target, valid active caller → 403 denial (no existence distinction)', async () => {
    const caller = await fx.user('umac05-caller', { firstName: 'Caller' });
    // A well-formed id that resolves to no `User` row.
    const missingTargetId = '01890000-0000-7000-8000-0000000000ff';

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${missingTargetId}`)
      .set('authorization', bearer(caller.id));

    // `resolveAudiences(V, [<missing>])` returns an empty `Set` (target is not
    // an active `User`) → the guard denies → `403`. A forbidden target and a
    // missing one get the identical response — there is no `404` branch on this
    // route.
    expect(res.status).toBe(403);
    expectLeakFreeBody(res.body);
  });
});
