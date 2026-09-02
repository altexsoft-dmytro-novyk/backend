import request from 'supertest';
import {
  RunFixtures,
  backdateMagicLinkTokenExpiry,
  bootstrapAuthTestApp,
  expectNoSessionToken,
  magicLinkTokenByRawToken,
  rawTokenFor,
  seedCurrentEmploymentStatus,
  sessionTokenOf,
  type AuthTestApp,
} from './fixtures';

/**
 * Epic 2 — Story 2.2 (Consume a Magic-Link Token to Establish a Session) ·
 * AD-1 Stage 2, committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/auth/
 *     README.md                              (Story 2.2 session-token decisions 9-14)
 *     um-auth-03-consume-magic-link-success.md
 *     um-auth-04-consume-expired-token-denied.md
 *     um-auth-05-consume-token-single-use.md
 *     um-auth-06-deactivated-user-denied.md  (consume half — Test 2)
 *   + the standing route-family rule: malformed / missing `token` → 400
 *     (auth/README.md decision 13).
 *
 * ── RED classification ─────────────────────────────────────────────────────
 *  EVERY test here is RED, for up to three compounding reasons:
 *
 *  (1) ROUTE MISSING — `POST /auth/magic-link/consume` does not exist.
 *      `AuthController` (`src/user-management/application/controllers/
 *      auth.controller.ts`) has only `@Post('magic-link')` (Story 2.1). Every
 *      `consume()` call below gets `404`, so the first
 *      `expect(status).toBe(200 | 401 | 400)` after it fails first.
 *
 *  (2) NO SESSION ISSUANCE — nothing in the codebase mints or returns a
 *      session token. There is no session-issuer service, no `SESSION_JWT_SECRET`
 *      / `SESSION_TTL_HOURS` config, no `Session` model. `um-auth-03` /
 *      `um-auth-05` Test 1 expect a `200` body carrying one.
 *
 *  (3) SESSION RESOLVER STILL INTERIM-ONLY — `SESSION_RESOLVER_PORT` is bound
 *      to `InterimSessionResolverAdapter`, which resolves ONLY the
 *      `Bearer <token:<uuid>>` fixture shorthand. A real session token from
 *      `/consume` resolves to `null`, so `um-auth-03`'s follow-up
 *      `GET /users/:id` would `401` even if (1) and (2) were fixed. Story 2.2
 *      lands the real adapter and retires the interim one (AD-21 — auth/README
 *      decision 12).
 *
 *  The mint precondition is NOT red: Story 2.1 shipped `POST /auth/magic-link`
 *  and the `magic_link_token` table, so `mintToken()` below performs a real
 *  mint and reads the real raw token from the AD-15 recording dispatcher
 *  (fixtures.ts `rawTokenFor`). `um-auth-04` back-dates that real row's
 *  `expiresAt` directly (DEC-UM-004 controllable-clock stand-in).
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, real
 * `AccessControlFacade`. The ONLY override is the AD-15 outbound email
 * dispatcher (see fixtures.ts) — the `um-auth-03` follow-up `GET /users/:id`
 * runs through the REAL session + AccessControl path. DEC-UM-010: one worker,
 * run-namespaced rows, wrapped teardown.
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
    // magic_link_token rows cascade away with their user (FK ON DELETE CASCADE).
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
   * Real in-suite precondition: request a magic link for `email` through the
   * real Story 2.1 route, then return the raw token the recording dispatcher
   * was asked to send. No placeholder — the mint request is part of this suite
   * and the token is a real out-of-band value (nest-e2e.md).
   */
  const mintToken = async (email: string): Promise<string> => {
    const mint = await request(server())
      .post('/auth/magic-link')
      .set('authorization', '')
      .send({ email });
    expect(mint.status).toBe(200);
    expect(mint.body).toEqual({ sent: true });

    const raw = rawTokenFor(testApp.dispatcher, email);
    expect(raw).toBeDefined();
    return String(raw);
  };

  const consume = (token: unknown) =>
    request(server())
      .post('/auth/magic-link/consume')
      .set('authorization', '')
      .send({ token });

  // docs/test-cases/user-management/auth/um-auth-03-consume-magic-link-success.md
  describe('um-auth-03 · consuming a valid token establishes a usable session', () => {
    it('um-auth-03 · 200 + session token scoped to Alice, consumedAt set, follow-up GET /users/:id → 200, replay → 401 [RED: POST /auth/magic-link/consume → 404; no session issuance; interim-only resolver]', async () => {
      const alice = await fx.user('auth03-alice', { firstName: 'Alice' });
      const token = await mintToken(alice.workEmail);

      // Test 1 — a valid token establishes a usable session.
      const res = await consume(token);
      expect(res.status).toBe(200);

      const session = sessionTokenOf(res.body);
      expect(session).toBeDefined();
      // Proposed body shape (auth/README decision 9) — assert the self-
      // describing fields without hard-coding the session-token field name.
      const body = res.body as Record<string, unknown>;
      expect(body.tokenType).toBe('Bearer');
      expect(typeof body.expiresIn).toBe('number');
      expect(body.expiresIn as number).toBeGreaterThan(0);

      // The token row is now spent.
      const row = await magicLinkTokenByRawToken(testApp.prisma, token);
      expect(row).not.toBeNull();
      expect(row?.consumedAt).not.toBeNull();

      // The session authenticates a real request, resolved through the real
      // SessionResolverPort adapter + real AccessControlFacade (self audience
      // over Alice's own S1 card) — no fake on either path.
      const followUp = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', `Bearer ${String(session)}`);
      expect(followUp.status).toBe(200);

      // Test 2 — the same token cannot be consumed again (generic 401).
      const replay = await consume(token);
      expect(replay.status).toBe(401);
      expectNoSessionToken(replay.body);
      expect(replay.headers['set-cookie']).toBeUndefined();
    });
  });

  // docs/test-cases/user-management/auth/um-auth-04-consume-expired-token-denied.md
  describe('um-auth-04 · consuming an expired token is denied', () => {
    it('um-auth-04 · expired token → 401, no session token, consumedAt stays null [RED: route + session issuance missing; DEC-UM-004]', async () => {
      const alice = await fx.user('auth04-alice', { firstName: 'Alice' });
      const token = await mintToken(alice.workEmail);

      // "The TTL has elapsed" — no request represents this (DEC-UM-004
      // controllable clock); back-date the real row directly.
      const touched = await backdateMagicLinkTokenExpiry(testApp.prisma, token);
      expect(touched).toBe(1);

      const res = await consume(token);
      expect(res.status).toBe(401);
      expectNoSessionToken(res.body);
      expect(res.headers['set-cookie']).toBeUndefined();

      // Expiry is not consumption — the row stays unspent.
      const row = await magicLinkTokenByRawToken(testApp.prisma, token);
      expect(row?.consumedAt).toBeNull();
    });
  });

  // docs/test-cases/user-management/auth/um-auth-05-consume-token-single-use.md
  describe('um-auth-05 · a token cannot be consumed twice (single-use anchor)', () => {
    it('um-auth-05 · first consume 200, replay of the same token → 401 with no session token [RED: route + session issuance missing; DEC-UM-004]', async () => {
      const alice = await fx.user('auth05-alice', { firstName: 'Alice' });
      const token = await mintToken(alice.workEmail);

      // Test 1 — baseline: first consumption succeeds.
      const first = await consume(token);
      expect(first.status).toBe(200);
      expect(sessionTokenOf(first.body)).toBeDefined();

      const row = await magicLinkTokenByRawToken(testApp.prisma, token);
      expect(row?.consumedAt).not.toBeNull();

      // Test 2 — replay of the same token value, by anyone, is denied.
      const replay = await consume(token);
      expect(replay.status).toBe(401);
      expectNoSessionToken(replay.body);
      expect(replay.headers['set-cookie']).toBeUndefined();
    });
  });

  // docs/test-cases/user-management/auth/um-auth-06-deactivated-user-denied.md (Test 2)
  describe('um-auth-06 · consume half — a pre-deactivation token yields no session', () => {
    it('um-auth-06 Test 2 · token minted while active, then account deactivated → consume → 401, no session token or Set-Cookie [RED: route + session issuance missing] [FR-6]', async () => {
      // Mint while Colin is still active — a deactivated address gets ZERO
      // dispatch (um-auth-02b), so the token cannot be minted afterward.
      const colin = await fx.user('auth06-colin', { firstName: 'Colin' });
      const token = await mintToken(colin.workEmail);

      // Departure takes effect: both signals of the applied-departure
      // convergence, seeded directly (Epic 5 outcome, CC-06-blocked). The
      // account-state check is at CONSUME time, on the current row.
      await testApp.prisma.user.update({
        where: { id: colin.id },
        data: { isActive: false },
      });
      await seedCurrentEmploymentStatus(testApp.prisma, colin.id, 'dismissed');

      const res = await consume(token);
      expect(res.status).toBe(401);
      expectNoSessionToken(res.body);
      expect(res.headers['set-cookie']).toBeUndefined();

      // The refused token is not marked consumed.
      const row = await magicLinkTokenByRawToken(testApp.prisma, token);
      expect(row?.consumedAt).toBeNull();
    });
  });

  // auth/README.md decision 13 — standing route-family rule (not a numbered scenario).
  describe('um-auth-consume-malformed · missing / empty / non-string token', () => {
    it('um-auth-consume-malformed · empty body, empty token, non-string token → 400 [RED: POST /auth/magic-link/consume → 404; no ConsumeMagicLinkDto]', async () => {
      const emptyBody = await request(server())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({});
      expect(emptyBody.status).toBe(400);

      const emptyToken = await consume('');
      expect(emptyToken.status).toBe(400);

      const nonString = await consume(42);
      expect(nonString.status).toBe(400);
    });
  });
});
