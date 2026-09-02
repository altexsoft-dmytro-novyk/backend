import request from 'supertest';
import type { TestApp } from './fixtures';
import {
  RunFixtures,
  bearer,
  bootstrapTestApp,
  expectExactS1CardEnvelope,
  s1CardOf,
} from './fixtures';

/**
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1) · AD-1 Stage 2
 * (green since UMAC-1-production; canEdit reconciled to Variant A 2026-09-02).
 *
 * Scenarios (one E2E per scenario, `UMAC-xx` id in the test title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     umac-01-self-read-s1-card.md
 *     umac-02-reporting-line-viewer-read.md
 *     umac-03-assigned-pp-read.md
 *     umac-04-colleague-read-s1-card.md
 *
 * STATE: green. `UMAC-1-production` shipped the S1-card DTO + `{ data, canEdit }`
 * envelope and rebound `ACCESS_CONTROL_PORT` to the real
 * `AccessControlFacade`-backed adapter, so `findOne` returns the envelope and
 * the whole-row technical fields are gone.
 *
 * `canEdit` under Variant A (product decision 2026-09-02 — the identity card has
 * NO separate functional permission; the whole gate is
 * `canAccessSection(V,'S1',T) === 'write'`):
 *   - self (UMAC-01): `canAccessSection` → `'read'` → `canEdit: false`.
 *   - reporting-line manager (UMAC-02) / assigned PP (UMAC-03):
 *     `canAccessSection` → `'write'` → `canEdit: true`.
 *   - colleague (UMAC-04): `canAccessSection` → `'read'` → `canEdit: false`.
 * There is no unseeded-permission dependency and no deferred flip.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` rows and issue
 * `Bearer <token:<seeded-uuid>>`.
 */
describe('UMAC-1 Stage 2 — GET /users/:id returns the S1 identity card (e2e)', () => {
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

  const getUser = (targetId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  // docs/test-cases/user-management/access-control-adoption/umac-01-self-read-s1-card.md
  it('UMAC-01 · Self reads own profile → 200 with exactly the S1 identity card', async () => {
    const viewer = await fx.user('umac01-self', {
      firstName: 'Self',
      birthDay: 3,
      birthMonth: 11,
    });

    const res = await getUser(viewer.id, viewer.id);

    expect(res.status).toBe(200);
    // Variant A: Self's `canAccessSection(V,'S1',V)` → 'read' (S1 is read-only
    // for self; only the photo is Self-writable) → `canEdit` false.
    expectExactS1CardEnvelope(res.body, s1CardOf(viewer), false);
  });

  // docs/test-cases/user-management/access-control-adoption/umac-02-reporting-line-viewer-read.md
  describe('UMAC-02 · Reporting-line viewer reads a report → 200 with the S1 card', () => {
    it('UMAC-02 Test 1 — direct report', async () => {
      const viewer = await fx.user('umac02-manager', { firstName: 'Manager' });
      const target = await fx.user('umac02-report', { firstName: 'Report' });
      // T reports to V — V resolves `reporting` over T.
      await fx.reportsTo(target.id, viewer.id);

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      // Variant A: a reporting-line viewer has `canAccessSection` → 'write', which
      // IS the whole edit gate → `canEdit` true.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), true);
    });

    it('UMAC-02 Test 2 — transitive reporting line (T → M → V)', async () => {
      const viewer = await fx.user('umac02t-skip', {
        firstName: 'SkipManager',
      });
      const middle = await fx.user('umac02t-mid', { firstName: 'MidManager' });
      const target = await fx.user('umac02t-report', { firstName: 'Report' });
      // T → M → V: `reporting` resolves through the transitive `direct` walk.
      await fx.reportsTo(target.id, middle.id);
      await fx.reportsTo(middle.id, viewer.id);

      const res = await getUser(target.id, viewer.id);

      expect(res.status).toBe(200);
      // Same as Test 1 — a transitive reporting-line viewer resolves 'write' →
      // `canEdit` true.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), true);
    });
  });

  // docs/test-cases/user-management/access-control-adoption/umac-03-assigned-pp-read.md
  it('UMAC-03 · Assigned People Partner reads an employee → 200 with the S1 card', async () => {
    const viewer = await fx.user('umac03-pp', { firstName: 'PeoplePartner' });
    const target = await fx.user('umac03-employee', { firstName: 'Employee' });
    // V is T's directly-assigned People Partner — V resolves `pp` over T.
    await fx.peoplePartnerOf(target.id, viewer.id);

    const res = await getUser(target.id, viewer.id);

    expect(res.status).toBe(200);
    // Variant A: an assigned PP has `canAccessSection` → 'write', which IS the
    // whole edit gate → `canEdit` true.
    expectExactS1CardEnvelope(res.body, s1CardOf(target), true);
  });

  // docs/test-cases/user-management/access-control-adoption/umac-04-colleague-read-s1-card.md
  it('UMAC-04 · Colleague / unrelated active session reads a profile → 200 with the same S1 card', async () => {
    const viewer = await fx.user('umac04-colleague', {
      firstName: 'Colleague',
    });
    const target = await fx.user('umac04-target', {
      firstName: 'Target',
      birthDay: 21,
      birthMonth: 6,
      workPhone: '+48 999 888 777',
    });
    // No Relationship edge either direction, V ≠ T → V's audience over T is the
    // `colleague` floor only. §3.2 S1 row is `R` for the Colleague column, so
    // this is a POSITIVE test: 200 with the identical S1 field set.

    const res = await getUser(target.id, viewer.id);

    expect(res.status).toBe(200);
    // Colleague: `canAccessSection(V,'S1',T)` → 'read', so `canEdit` is false.
    // Unlike reporting / pp, a colleague never gains S1 write access.
    expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
  });
});
