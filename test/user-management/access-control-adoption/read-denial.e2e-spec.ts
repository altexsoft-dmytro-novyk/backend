import request from 'supertest';
import type { TestApp } from './fixtures';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectLeakFreeBody,
} from './fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1).
 *
 * Scenario: docs/test-cases/user-management/access-control-adoption/
 *   umac-05-unresolved-session-read-denied.md
 *
 * `GET /users/:id` has TWO denial shapes and NO `404` authorization branch (the
 * "leak-free 404" convention was withdrawn 2026-09-01 — internal directory,
 * standard REST codes):
 *   - **Unresolved session → `401`** (the SESSION layer). Epic 2's real
 *     `JwtSessionResolverAdapter` returns `null` for a token — JWT or the
 *     `<token:persona>` test shorthand — whose principal is not an *active*
 *     `User`: a literal persona placeholder (`<token:Bob>`), a deactivated
 *     caller, or a bogus id. (The retired interim resolver was lax and let these
 *     reach the guard as an empty-audience `403`.)
 *   - **Authenticated active viewer, empty audience → `403`.** On this read
 *     route `colleague` is the floor, so an empty audience means the target is
 *     not an active `User`. No existence distinction — a forbidden target and a
 *     missing target both return `403`, from `AccessControlGuard`'s denied
 *     `isAllowedForTarget`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides.
 */
describe('UMAC-1 — GET /users/:id denials: 401 unresolved session / 403 empty audience (e2e)', () => {
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
  it('UMAC-05 Test 1 — literal placeholder id (Bearer <token:Bob>) → 401 (unresolved session, leak-free body)', async () => {
    const target = await fx.user('umac05-target', { firstName: 'Target' });

    // `Bearer <token:Bob>` — persona 'Bob' matches no active User, so the
    // session does not resolve. Absence of a session is `401`, distinct from an
    // authenticated principal with an empty audience (`403`). Epic 2's real
    // `JwtSessionResolverAdapter` replaced the lax interim one that used to let
    // this surface as `403`.
    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', 'Bearer <token:Bob>');

    expect(res.status).toBe(401);
    expectLeakFreeBody(res.body, target);
  });

  it('UMAC-05 Test 2 — deactivated caller (isActive: false) → 401 (unresolved session, leak-free body)', async () => {
    const target = await fx.user('umac05-target2', { firstName: 'Target' });
    const deactivatedCaller = await fx.user('umac05-deactivated', {
      firstName: 'Deactivated',
      isActive: false,
    });

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', bearer(deactivatedCaller.id));

    // An inactive `User` establishes no session — Epic 2's real resolver
    // returns `null` for a persona that is not an *active* `User`, so the guard
    // rejects with `401` before any audience resolution (the interim resolver
    // used to let this reach the guard as an empty-audience `403`).
    expect(res.status).toBe(401);
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
