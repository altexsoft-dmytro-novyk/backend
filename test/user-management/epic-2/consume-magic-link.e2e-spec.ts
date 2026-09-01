import request from 'supertest';
import {
  RunFixtures,
  bootstrapAuthTestApp,
  expectNoSessionToken,
  sessionTokenOf,
  type AuthTestApp,
} from './fixtures';

/**
 * Epic 2 — Story 2.2 (Consume a Magic-Link Token to Establish a Session) ·
 * AD-1 Stage 2, committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/auth/
 *     um-auth-03-consume-magic-link-success.md
 *     um-auth-04-consume-expired-token-denied.md
 *     um-auth-05-consume-token-single-use.md
 *     um-auth-06-deactivated-user-denied.md  (consume half — Test 2)
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *  ALL FOUR:   RED — red-because-route-missing AND red-because-model-missing.
 *              (1) `POST /auth/magic-link` and `POST /auth/magic-link/consume`
 *                  do not exist (no `/auth` route in `src/user-management/`).
 *              (2) There is no `MagicLinkToken` / session model in
 *                  `prisma/schema.prisma` (User / Relationship / Project /
 *                  Policy… only — `epic-2-context.md` "not yet in the schema").
 *              The tests fail first at the real mint call
 *              `POST /auth/magic-link` → `404`.
 *
 * TOKEN SEAM (nest-e2e.md "delivered exclusively out-of-band with no
 * HTTP-observable seam" + HARD RULE 4(b)). The mint request IS in this suite,
 * so `POST /auth/magic-link` is chained for real as the precondition. But the
 * token value itself is delivered by email and no model / readback seam exists
 * yet, and the outbound dispatcher port only receives `workEmail`, not the
 * token — so a literal placeholder (`<magic-link-token:alice>`) is the
 * sanctioned stand-in, exactly as the pre-v1.5 `auth.e2e-spec.ts` and the
 * scenario docs use it. When Story 2.2 lands the token model, replace
 * `mintToken()` below with a real read of the minted row via the injected
 * `prisma` handle (and back-date `expiresAt` for `um-auth-04` there).
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, the only override
 * is the AD-15 outbound dispatcher (see fixtures.ts). The `um-auth-03`
 * follow-up `GET /users/:id` runs through the REAL session + AccessControl path
 * (no fake). DEC-UM-010: one worker, run-namespaced rows, wrapped teardown.
 */
describe('Epic 2 · Consume a magic link — POST /auth/magic-link/consume (e2e)', () => {
  let testApp: AuthTestApp;
  let fx: RunFixtures;

  beforeAll(async () => {
    testApp = await bootstrapAuthTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
    testApp.dispatcher.reset();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  afterAll(async () => {
    try {
      await testApp.prisma.user.deleteMany({
        where: { workEmail: { startsWith: 'interim-root-' } },
      });
    } catch (error) {
      console.warn('[consume-magic-link] interim-root sweep failed', error);
    }
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  const server = () => testApp.app.getHttpServer();

  /**
   * Real in-suite precondition: request a magic link for `email`, then return
   * the token value to submit to `/consume`.
   *
   * TODO(Story 2.2): once the token model exists, read the freshly-minted row
   * here (`prisma.<magicLinkToken>.findFirst({ where: { user: { workEmail }},
   * orderBy: { createdAt: 'desc' }})`) and return its real `token`. Until then
   * the mint call `404`s and this returns the documented placeholder, so the
   * consume assertion below is committed-red on the missing route/model.
   */
  const mintToken = async (
    email: string,
    placeholder: string,
  ): Promise<string> => {
    const mint = await request(server())
      .post('/auth/magic-link')
      .set('authorization', '')
      .send({ email });
    // RED today: no route → 404. This is the first failing assertion.
    expect(mint.status).toBe(200);
    return placeholder;
  };

  const consume = (token: string) =>
    request(server())
      .post('/auth/magic-link/consume')
      .set('authorization', '')
      .send({ token });

  // docs/test-cases/user-management/auth/um-auth-03-consume-magic-link-success.md
  describe('um-auth-03 · consuming a valid token establishes a usable session', () => {
    it('um-auth-03 · 200 with a session token scoped to Alice; follow-up GET /users/:id → 200 [RED: route + model missing — POST /auth/magic-link → 404]', async () => {
      const alice = await fx.user('auth03-alice', { firstName: 'Alice' });

      const token = await mintToken(
        alice.workEmail,
        '<magic-link-token:alice>',
      );

      const res = await consume(token);
      expect(res.status).toBe(200);
      const session = sessionTokenOf(res.body);
      expect(session).toBeDefined();

      // The session must work on a real authenticated request, resolved through
      // the real session + AccessControl path (Epic 0's adapter), not a fake.
      const followUp = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', `Bearer ${String(session)}`);
      expect(followUp.status).toBe(200);
    });
  });

  // docs/test-cases/user-management/auth/um-auth-04-consume-expired-token-denied.md
  describe('um-auth-04 · consuming an expired token is denied', () => {
    it('um-auth-04 · expired token → 401, no session token in body [RED: route + model missing; expiry is TTL/clock-owned — DEC-UM-004]', async () => {
      // DEC-UM-004: TTL is configuration-owned; tests inject a deterministic
      // TTL + controllable clock. Neither a clock DI seam nor the token model
      // exists yet, so a distinct placeholder stands in for "a token whose TTL
      // has elapsed" — same mechanism the pre-v1.5 auth.e2e-spec.ts used.
      // TODO(Story 2.2): mint a real token, then back-date its `expiresAt` via
      // the injected prisma handle (or advance the injected clock past the TTL).
      const alice = await fx.user('auth04-alice', { firstName: 'Alice' });

      const token = await mintToken(
        alice.workEmail,
        '<expired-magic-link-token:alice>',
      );

      const res = await consume(token);
      expect(res.status).toBe(401);
      expectNoSessionToken(res.body);
    });
  });

  // docs/test-cases/user-management/auth/um-auth-05-consume-token-single-use.md
  describe('um-auth-05 · a token cannot be consumed twice', () => {
    it('um-auth-05 · first consume 200, replay of the same token → 401 with no session token [RED: route + model missing — POST /auth/magic-link → 404]', async () => {
      const alice = await fx.user('auth05-alice', { firstName: 'Alice' });

      const token = await mintToken(
        alice.workEmail,
        '<magic-link-token:alice>',
      );

      // Test 1 — baseline: first consumption succeeds.
      const first = await consume(token);
      expect(first.status).toBe(200);
      expect(sessionTokenOf(first.body)).toBeDefined();

      // Test 2 — replay of the same token value, by anyone, is denied.
      const replay = await consume(token);
      expect(replay.status).toBe(401);
      expectNoSessionToken(replay.body);
    });
  });

  // docs/test-cases/user-management/auth/um-auth-06-deactivated-user-denied.md (Test 2)
  describe('um-auth-06 · consume half — a pre-deactivation token yields no session', () => {
    it('um-auth-06 Test 2 · token issued before deactivation → 401, no session token in body or Set-Cookie [RED: route + model missing] [FR-6]', async () => {
      // Colin's inactive state is an Epic 5 departure outcome (CC-06-blocked);
      // stage 2 seeds `isActive: false` directly. The token was "issued before
      // deactivation" — placeholder per the token-seam note above.
      const colin = await fx.user('auth06-colin', {
        firstName: 'Colin',
        isActive: false,
      });

      // Mint is attempted for Colin's address (enumeration-safe, so it still
      // returns 200 once the route lands); the token value is the pre-existing
      // placeholder.
      const token = await mintToken(
        colin.workEmail,
        '<magic-link-token:colin-deactivated>',
      );

      const res = await consume(token);
      expect(res.status).toBe(401);
      expectNoSessionToken(res.body);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});
