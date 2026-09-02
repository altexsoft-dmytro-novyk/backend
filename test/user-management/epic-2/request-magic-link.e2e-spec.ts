import request from 'supertest';
import {
  RecordingMagicLinkDispatcher,
  RunFixtures,
  bootstrapAuthTestApp,
  magicLinkTokenCount,
  magicLinkTokenRowsForUser,
  magicLinkTokenTableExists,
  seedCurrentEmploymentStatus,
  type AuthTestApp,
} from './fixtures';

/**
 * Epic 2 — Story 2.1 (Request a Magic Link by Work Email) · AD-1 Stage 2,
 * committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/auth/
 *     README.md                                       (canonical personas + in-scenario decisions)
 *     um-auth-01-request-magic-link-success.md
 *     um-auth-02-request-magic-link-unknown-email.md
 *     um-auth-02b-request-magic-link-deactivated-email.md
 *   + the standing route-family rule: malformed / missing `email` → 400
 *     (auth/README.md decision 7).
 *
 * ── RED classification ─────────────────────────────────────────────────────
 *  EVERY test here is RED for the same primary reason: `POST /auth/magic-link`
 *  DOES NOT EXIST. There is no `AuthController` / `/auth` route anywhere in
 *  `src/` (grep: only `@Controller('users')`). Every request below gets `404`,
 *  so the first `expect(status).toBe(200 | 400)` assertion fails first.
 *
 *  um-auth-01 carries a SECOND red reason past the route: there is no
 *  `magic_link_token` table (`MagicLinkToken` is not in `prisma/schema.prisma`
 *  — Story 2.1 Stage 3 adds it; auth/README.md decision 2). The "a token row was
 *  minted" assertions only start mattering once the route AND the table land.
 *
 * Preconditions are REAL (`.claude/rules/nest-e2e.md`): `User` rows are direct
 * Prisma inserts via `RunFixtures.user()` — there is NO `POST /users` in v1.5
 * (AD-14 / AD-16 / AD-21).
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL. The ONLY override
 * is the AD-15 outbound email dispatcher, rebound to a recording variant of the
 * same fake so "zero dispatch" / "exactly one dispatch" is observable — see
 * fixtures.ts. DEC-UM-010: one worker, run-namespaced rows, wrapped teardown.
 */
describe('Epic 2 · Request a magic link — POST /auth/magic-link (e2e)', () => {
  let testApp: AuthTestApp;
  let fx: RunFixtures;
  let dispatcher: RecordingMagicLinkDispatcher;

  beforeAll(async () => {
    testApp = await bootstrapAuthTestApp();
    dispatcher = testApp.dispatcher;
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
    dispatcher.reset();
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
      console.warn('[request-magic-link] interim-root sweep failed', error);
    }
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  const requestLink = (email: unknown) =>
    request(testApp.app.getHttpServer())
      .post('/auth/magic-link')
      .set('authorization', '')
      .send({ email });

  const SENSITIVE_KEYS = [
    'token',
    'password',
    'accessToken',
    'sessionToken',
    'magicLink',
    'link',
    'email',
  ];

  /**
   * The token count before a request, or `null` when the `magic_link_token`
   * table does not exist yet (pre-Stage-3). A `null` here means "the token-row
   * assertions are moot — the route 404 already made this test red".
   */
  const tokenCountOrNull = async (): Promise<number | null> =>
    (await magicLinkTokenTableExists(testApp.prisma))
      ? magicLinkTokenCount(testApp.prisma)
      : null;

  // docs/test-cases/user-management/auth/um-auth-01-request-magic-link-success.md
  describe('um-auth-01 · request a magic link for a registered active email', () => {
    it('um-auth-01 · 200 { sent: true }, no sensitive field, exactly one dispatch, one MagicLinkToken row minted [RED: POST /auth/magic-link → 404; no magic_link_token table]', async () => {
      const alice = await fx.user('auth01-alice', { firstName: 'Alice' });
      const before = await tokenCountOrNull();

      // DEC-UM-007: submit the address differently cased / whitespace-padded —
      // the lookup must normalize (`trim().toLowerCase()`) before matching the
      // stored `workEmail`.
      const res = await requestLink(`  ${alice.workEmail.toUpperCase()}  `);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toEqual({ sent: true });
      for (const key of SENSITIVE_KEYS) {
        expect(body).not.toHaveProperty(key);
      }

      // DEC-UM-004 known email → dispatch exactly one magic link, to Alice only.
      expect(dispatcher.countFor(alice.workEmail)).toBe(1);
      expect(dispatcher.dispatched).toEqual([alice.workEmail]);

      // A MagicLinkToken row exists for Alice: unconsumed, not-yet-expired.
      expect(await magicLinkTokenTableExists(testApp.prisma)).toBe(true);
      const rows = await magicLinkTokenRowsForUser(testApp.prisma, alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].consumedAt).toBeNull();
      expect(new Date(rows[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
      if (before !== null) {
        expect(await magicLinkTokenCount(testApp.prisma)).toBe(before + 1);
      }
    });
  });

  // docs/test-cases/user-management/auth/um-auth-02-request-magic-link-unknown-email.md
  describe('um-auth-02 · request a magic link for an unregistered email', () => {
    it('um-auth-02 · byte-identical 200 body to a known email AND zero dispatch / zero token for the unknown address (enumeration guard) [RED: POST /auth/magic-link → 404]', async () => {
      const known = await fx.user('auth02-known', { firstName: 'Alice' });
      const unknownEmail = fx.emailFor('auth02-nobody'); // never seeded

      const before = await tokenCountOrNull();

      const knownRes = await requestLink(known.workEmail);
      const unknownRes = await requestLink(unknownEmail);

      // Enumeration-safety: same status, BYTE-IDENTICAL body (raw response text,
      // not just deep-equal shape) — auth/README.md decision 1.
      expect(unknownRes.status).toBe(200);
      expect(unknownRes.status).toBe(knownRes.status);
      expect(unknownRes.body).toEqual(knownRes.body);
      expect(unknownRes.text).toBe(knownRes.text);

      // DEC-UM-004 unknown email → ZERO dispatch (asserted at the email fake).
      expect(dispatcher.countFor(unknownEmail)).toBe(0);
      // Sanity: the known request in the same test did dispatch exactly once.
      expect(dispatcher.countFor(known.workEmail)).toBe(1);

      // Exactly one new token overall — the known user's; nothing for the
      // unknown address.
      if (before !== null) {
        expect(await magicLinkTokenCount(testApp.prisma)).toBe(before + 1);
        expect(
          await magicLinkTokenRowsForUser(testApp.prisma, known.id),
        ).toHaveLength(1);
      }
    });
  });

  // docs/test-cases/user-management/auth/um-auth-02b-request-magic-link-deactivated-email.md
  describe('um-auth-02b · request a magic link for a deactivated user’s email (DEC-UM-012, DRAFT)', () => {
    it('um-auth-02b · deactivated email → byte-identical 200 shape, zero dispatch, zero token [RED: POST /auth/magic-link → 404] [DEC-UM-012 proposed/draft]', async () => {
      // Colin's deactivated state = the applied-departure convergence: BOTH
      // `isActive: false` AND a current `EmploymentStatus{dismissed}` are seeded
      // (auth/README.md decision 5) so the assertion holds whichever signal
      // Stage 3 keys on. In production this is an Epic 5 outcome (CC-06-blocked);
      // stage 2 seeds it directly.
      const colin = await fx.user('auth02b-colin', {
        firstName: 'Colin',
        isActive: false,
      });
      await seedCurrentEmploymentStatus(testApp.prisma, colin.id, 'dismissed');
      const active = await fx.user('auth02b-active', { firstName: 'Alice' });

      const before = await tokenCountOrNull();

      const activeRes = await requestLink(active.workEmail);
      const colinRes = await requestLink(colin.workEmail);

      // DEC-UM-012 (draft): a deactivated address is treated exactly like an
      // unknown one — the endpoint reveals nothing about deactivation status.
      expect(colinRes.status).toBe(200);
      expect(colinRes.status).toBe(activeRes.status);
      expect(colinRes.body).toEqual(activeRes.body);
      expect(colinRes.text).toBe(activeRes.text);

      // Zero dispatch, zero token for the deactivated address.
      expect(dispatcher.countFor(colin.workEmail)).toBe(0);
      if (before !== null) {
        expect(
          await magicLinkTokenRowsForUser(testApp.prisma, colin.id),
        ).toHaveLength(0);
        // Only the active user's token was minted across the two calls.
        expect(await magicLinkTokenCount(testApp.prisma)).toBe(before + 1);
      }
    });
  });

  // auth/README.md decision 7 — standing route-family rule (not a numbered scenario).
  describe('um-auth · malformed request body', () => {
    it('um-auth · empty body / non-email `email` → 400, nothing dispatched, no token [RED: POST /auth/magic-link → 404]', async () => {
      const before = await tokenCountOrNull();

      const emptyBody = await request(testApp.app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({});
      expect(emptyBody.status).toBe(400);

      const notAnEmail = await requestLink('not-an-email');
      expect(notAnEmail.status).toBe(400);

      const nonString = await requestLink(42);
      expect(nonString.status).toBe(400);

      expect(dispatcher.dispatched).toHaveLength(0);
      if (before !== null) {
        expect(await magicLinkTokenCount(testApp.prisma)).toBe(before);
      }
    });
  });
});
