import request from 'supertest';
import {
  RecordingMagicLinkDispatcher,
  RunFixtures,
  bootstrapAuthTestApp,
  type AuthTestApp,
} from './fixtures';

/**
 * Epic 2 — Story 2.1 (Request a Magic Link by Work Email) · AD-1 Stage 2,
 * committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/auth/
 *     um-auth-01-request-magic-link-success.md
 *     um-auth-02-request-magic-link-unknown-email.md
 *     um-auth-06-deactivated-user-denied.md  (request half — Test 1)
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *  ALL THREE:  RED — red-because-route-missing. `POST /auth/magic-link` does
 *              not exist (no `AuthController`, no `/auth` route in
 *              `src/user-management/`; `epics.md` Epic 2 / `spec-2-1`). Every
 *              request below gets `404`, so the `expect(status).toBe(200)`
 *              assertion fails first. The dispatch-count assertions (the
 *              DEC-UM-004 / DEC-UM-012 security behaviour this file really
 *              encodes) only start mattering once the route lands.
 *
 * Preconditions are REAL (nest-e2e.md): the `User` rows are direct Prisma
 * inserts via `RunFixtures.user()` — there is NO `POST /users` in v1.5 (the
 * pre-v1.5 `auth.e2e-spec.ts` chained that now-retired route; do not).
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

  const requestLink = (email: string) =>
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
  ];

  // docs/test-cases/user-management/auth/um-auth-01-request-magic-link-success.md
  describe('um-auth-01 · request a magic link for a registered email', () => {
    it('um-auth-01 · 200 { sent: true }, no sensitive field, exactly one dispatch to that address [RED: route missing — POST /auth/magic-link → 404]', async () => {
      const alice = await fx.user('auth01-alice', { firstName: 'Alice' });

      const res = await requestLink(alice.workEmail);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
      for (const key of SENSITIVE_KEYS) {
        expect(body).not.toHaveProperty(key);
      }

      // DEC-UM-004 known email → dispatch exactly one magic link, to Alice only.
      expect(dispatcher.countFor(alice.workEmail)).toBe(1);
      expect(dispatcher.dispatched).toEqual([alice.workEmail]);
    });
  });

  // docs/test-cases/user-management/auth/um-auth-02-request-magic-link-unknown-email.md
  describe('um-auth-02 · request a magic link for an unregistered email', () => {
    it('um-auth-02 · identical 200 body shape to a known email AND zero dispatch for the unknown address (enumeration guard) [RED: route missing — POST /auth/magic-link → 404]', async () => {
      const known = await fx.user('auth02-known', { firstName: 'Alice' });
      const unknownEmail = fx.emailFor('auth02-nobody'); // never seeded

      const knownRes = await requestLink(known.workEmail);
      const unknownRes = await requestLink(unknownEmail);

      // Enumeration-safety: same status, byte-identical body shape.
      expect(unknownRes.status).toBe(200);
      expect(unknownRes.status).toBe(knownRes.status);
      expect(unknownRes.body).toEqual(knownRes.body);

      // DEC-UM-004 unknown email → ZERO dispatch (asserted at the email fake).
      expect(dispatcher.countFor(unknownEmail)).toBe(0);
      // Sanity: the known request in the same test did dispatch exactly once.
      expect(dispatcher.countFor(known.workEmail)).toBe(1);
    });
  });

  // docs/test-cases/user-management/auth/um-auth-06-deactivated-user-denied.md (Test 1)
  describe('um-auth-06 · request half — a deactivated user’s email is enumeration-safe (DEC-UM-012, DRAFT)', () => {
    it('um-auth-06 Test 1 · deactivated email → identical 200 shape, zero dispatch [RED: route missing — POST /auth/magic-link → 404] [DEC-UM-012 proposed/draft]', async () => {
      // Colin's inactive state is an Epic 5 departure outcome (CC-06-blocked);
      // stage 2 seeds `isActive: false` directly per the scenario doc.
      const colin = await fx.user('auth06-colin', {
        firstName: 'Colin',
        isActive: false,
      });
      const active = await fx.user('auth06-active', { firstName: 'Alice' });

      const activeRes = await requestLink(active.workEmail);
      const colinRes = await requestLink(colin.workEmail);

      // DEC-UM-012 (draft): a deactivated address is treated exactly like an
      // unknown one — the endpoint reveals nothing about deactivation status.
      expect(colinRes.status).toBe(200);
      expect(colinRes.status).toBe(activeRes.status);
      expect(colinRes.body).toEqual(activeRes.body);

      // Zero dispatch for the deactivated address.
      expect(dispatcher.countFor(colin.workEmail)).toBe(0);
    });
  });
});
