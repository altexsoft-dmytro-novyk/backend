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
 * Epic 0 — Access Control Adoption · Story 0.1 (UMAC-1) · AD-1 Stage 2,
 * committed red.
 *
 * Scenarios (one E2E per scenario, `UMAC-xx` id in the test title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     umac-01-self-read-s1-card.md
 *     umac-02-reporting-line-viewer-read.md
 *     umac-03-assigned-pp-read.md
 *     umac-04-colleague-read-s1-card.md
 *
 * WHY RED (per test): every test here is
 * **red-because-not-implemented (S1-card envelope + narrowing)**. The `200`
 * status already passes under the interim adapter (`isAllowedForTarget` returns
 * `Boolean(userId)`), but `findOne` still serializes through the whole-row
 * `toUserResponse`, so the body is the bare `User` row — NOT the
 * `{ data, canEdit }` envelope the approved `umac-01..04` scenarios require.
 * `expectExactS1CardEnvelope` therefore fails on two counts at once:
 *   1. `Object.keys(body)` is the ~17 `User` columns, not `['canEdit','data']`;
 *      `body.data` and `body.canEdit` are `undefined`.
 *   2. even reading through to the (absent) `data`, the row still carries
 *      `ttId` / `isActive` / `customFields` / `createdAt` / `createdBy`.
 * Goes green only when `UMAC-1-production` ships the S1-card DTO wrapped in the
 * read envelope and rebinds `ACCESS_CONTROL_PORT` to the real
 * `AccessControlFacade`-backed adapter.
 *
 * `canEdit` is `false` for all four reads today — for two different reasons
 * (both asserted as `false` here):
 *   - self / reporting / pp: `canAccessSection(V,'S1',T) === 'write'`, but
 *     `user-management:edit` is unseeded (Open Decision (i) = option (a),
 *     pending) so `isAllowed` fails closed. These flip to `canEdit: true` once
 *     the UMAC-2 kernel-seed sequence for `user-management:edit` reaches
 *     `stage-3-production`.
 *   - colleague (UMAC-04): `canAccessSection(V,'S1',T) === 'read'`, so `canEdit`
 *     is `false` regardless of any permission and never flips.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` rows and issue
 * `Bearer <token:<seeded-uuid>>`.
 */
describe('UMAC-1 Stage 2 (red) — GET /users/:id returns the S1 identity card (e2e)', () => {
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
    // Self: `canAccessSection` → 'write', but `user-management:edit` is unseeded
    // → `canEdit` false today; flips to true after the UMAC-2 kernel-seed
    // sequence for `user-management:edit`.
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
      // Reporting-line viewer: `canAccessSection` → 'write', `user-management:edit`
      // unseeded → `canEdit` false today; flips to true after the UMAC-2
      // kernel-seed sequence.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
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
      // Same as Test 1 — `canEdit` false today, flips to true after the UMAC-2
      // kernel-seed sequence for `user-management:edit`.
      expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
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
    // Assigned PP: `canAccessSection` → 'write', `user-management:edit` unseeded
    // → `canEdit` false today; flips to true after the UMAC-2 kernel-seed
    // sequence.
    expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
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
    // Colleague: `canAccessSection(V,'S1',T)` → 'read', so `canEdit` is false
    // regardless of any functional permission and NEVER flips to true (unlike
    // self / reporting / pp above).
    expectExactS1CardEnvelope(res.body, s1CardOf(target), false);
  });
});
