import request from 'supertest';
import {
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
} from './fixtures';

/**
 * Epic 1 — Story 1.5 (List Employees with Pagination and Filters) · AD-1 Stage 2.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/list/
 *     um-list-01-pagination-metadata.md
 *     um-list-02-filter-country.md
 *     um-list-03-compound-filters.md
 *     um-list-04-filter-remaining-identity-fields.md
 *     um-list-05-dismissed-employee-filterable.md   (new this pass)
 *
 * `Bearer <token:Root>` is a no-target `user-management:list` capability check
 * (interim adapter allows the resolved HR-Admin row; unaffected by the
 * target-scoped tier walk). Rows are **real Prisma inserts** with a run prefix
 * — there is no `POST /users` in v1.5.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *  um-list-01..04         GREEN — already-green characterization. `GET /users`,
 *              the `PaginatedResponseDto` envelope (`items/total/page/pageSize`),
 *              and every S1-field filter (`list-users.action.ts` +
 *              `user.repository.ts:list`) are wired. These lock the behaviour
 *              in against the AD-21 fixture cutover.
 *  um-list-05  RED (committed):
 *    Test 1  GREEN — the repo already defaults to `isActive: true`
 *              (`user.repository.ts:71`), so a dismissed row seeded as
 *              `isActive:false` (the documented interim for the §4.16
 *              `EmploymentStatus` fact) is absent by default.
 *    Test 2  RED — red-because-not-implemented. `employmentStatus` is not a
 *              `ListUsersQueryDto` field, so `ValidationPipe` `whitelist:true`
 *              strips it; the default (active-only) page comes back and the
 *              dismissed employee is never returned. No `employmentStatus`
 *              predicate / projection exists.
 *    Test 3  RED — red-because-wrong-behaviour. `isActive` IS a
 *              `ListUsersQueryDto` field today (`list-users-query.dto.ts:58`),
 *              so `?isActive=false` returns a list of inactive rows. FR-15 says
 *              the internal `isActive` flag is never a public filter predicate —
 *              the param must be ignored or rejected.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. DEC-UM-010: one worker, run-namespaced rows, wrapped teardown.
 */

const ROOT = bearer('Root');

interface Envelope {
  items?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  total?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

const itemsOf = (body: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  const e = body as Envelope;
  return e.items ?? e.data ?? e.results ?? [];
};

describe('Epic 1 · Employee list — GET /users (e2e)', () => {
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
    // `bearer('Root')` makes `InterimSessionResolverAdapter` lazily provision an
    // `interim-root-*` HR-Admin stand-in when no real root exists; sweep it so a
    // full-suite run stays tidy (the pre-v1.5 list/profile specs leaked these).
    try {
      await testApp.prisma.user.deleteMany({
        where: { workEmail: { startsWith: 'interim-root-' } },
      });
    } catch (error) {
      console.warn('[list-v15] interim-root sweep failed', error);
    }
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  const list = (query: Record<string, unknown>) =>
    request(testApp.app.getHttpServer())
      .get('/users')
      .query(query)
      .set('authorization', ROOT);

  // docs/test-cases/user-management/list/um-list-01-pagination-metadata.md
  describe('um-list-01 · list users returns pagination metadata', () => {
    it('returns a page of results (<= pageSize) plus total/page/pageSize [GREEN: characterization]', async () => {
      await Promise.all(
        Array.from({ length: 15 }, (_, i) => fx.user(`list01-${i}`)),
      );

      const res = await list({ page: 1, pageSize: 10 });
      expect(res.status).toBe(200);

      const items = itemsOf(res.body);
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(10);

      const body = res.body as Envelope;
      const total =
        body.total ??
        (body as Record<string, unknown>).totalCount ??
        ((body as Record<string, unknown>).meta as Record<string, unknown>)
          ?.total;
      expect(total).toBeDefined();
      expect(Number(total)).toBeGreaterThanOrEqual(15);
      expect(Number(body.page)).toBe(1);
      expect(Number(body.pageSize)).toBe(10);
    });
  });

  // docs/test-cases/user-management/list/um-list-02-filter-country.md
  describe('um-list-02 · list users filtered by country', () => {
    it('?country=Poland → every returned record has country "Poland" [GREEN: characterization]', async () => {
      await fx.user('list02-pl-1', { country: 'Poland' });
      await fx.user('list02-pl-2', { country: 'Poland' });
      await fx.user('list02-de', { country: 'Germany' });

      const res = await list({ country: 'Poland', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.country).toBe('Poland');
    });
  });

  // docs/test-cases/user-management/list/um-list-03-compound-filters.md
  describe('um-list-03 · list users with compound filters', () => {
    it('?position=Engineer&city=Krakow → every returned record matches both [GREEN: characterization]', async () => {
      await fx.user('list03-match', { position: 'Engineer', city: 'Krakow' });
      await fx.user('list03-wrong-city', {
        position: 'Engineer',
        city: 'Warsaw',
      });
      await fx.user('list03-wrong-pos', {
        position: 'QA Engineer',
        city: 'Krakow',
      });

      const res = await list({
        position: 'Engineer',
        city: 'Krakow',
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.position).toBe('Engineer');
        expect(item.city).toBe('Krakow');
      }
    });
  });

  // docs/test-cases/user-management/list/um-list-04-filter-remaining-identity-fields.md
  describe('um-list-04 · list users filtered by the remaining S1 identity fields', () => {
    let aliceId: string;
    let colinId: string;
    let colinEmail: string;
    const ttId = `tt-list04-${Date.now()}`;

    beforeEach(async () => {
      const alice = await fx.user('list04-alice', {
        firstName: 'Alicja',
        lastName: 'Larsson',
        birthDay: 15,
        birthMonth: 3,
        workPhone: '+48-11-222-3333',
        companyJoinDate: '2022-04-01',
      });
      aliceId = alice.id;

      const colin = await fx.user('list04-colin', {
        firstName: 'Colin',
        lastName: 'Baseline',
        ttId,
      });
      colinId = colin.id;
      colinEmail = colin.workEmail;

      // Contrast: differs on every field under test; shares birthDay (not
      // birthMonth) with Alice so the compound birthday filter can prove it
      // excludes a partial match.
      await fx.user('list04-contrast', {
        firstName: 'Zack',
        lastName: 'Zimmer',
        birthDay: 15,
        birthMonth: 7,
        workPhone: '+48-99-888-7777',
        companyJoinDate: '2023-01-01',
      });
    });

    it('Test 1 — filter by lastName [GREEN]', async () => {
      const res = await list({ lastName: 'Larsson', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.lastName).toBe('Larsson');
    });

    it('Test 2 — filter by workEmail → exactly the one record (Colin) [GREEN]', async () => {
      const res = await list({ workEmail: colinEmail, pageSize: 100 });
      expect(res.status).toBe(200);
      expect(itemsOf(res.body).map((u) => u.id)).toEqual([colinId]);
    });

    it('Test 3 — filter by ttId → exactly the one record (Colin) [GREEN]', async () => {
      const res = await list({ ttId, pageSize: 100 });
      expect(res.status).toBe(200);
      expect(itemsOf(res.body).map((u) => u.id)).toEqual([colinId]);
    });

    it('Test 4 — compound birthDay + birthMonth excludes a partial match [GREEN]', async () => {
      const res = await list({ birthDay: 15, birthMonth: 3, pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.birthDay).toBe(15);
        expect(item.birthMonth).toBe(3);
      }
      expect(items.some((u) => u.id === aliceId)).toBe(true);
    });

    it('Test 5 — filter by firstName [GREEN]', async () => {
      const res = await list({ firstName: 'Alicja', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.firstName).toBe('Alicja');
    });

    it('Test 6 — filter by workPhone [GREEN]', async () => {
      const res = await list({ workPhone: '+48-11-222-3333', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.workPhone).toBe('+48-11-222-3333');
    });

    it('Test 7 — filter by companyJoinDate [GREEN]', async () => {
      const res = await list({ companyJoinDate: '2022-04-01', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.companyJoinDate).toBe('2022-04-01');
    });
  });

  // docs/test-cases/user-management/list/um-list-05-dismissed-employee-filterable.md
  describe('um-list-05 · a dismissed employee is absent by default but filterable', () => {
    let aliceId: string;
    let colinId: string;

    beforeEach(async () => {
      // Interim per the spec: the §4.16 `EmploymentStatus` = dismissed fact is
      // seeded directly as `isActive:false` (documented stopgap until the
      // EmploymentStatus aggregate lands — Epic 5 / CC-06). No departure
      // executor dependency.
      const alice = await fx.user('list05-alice', {
        firstName: 'Alice',
        isActive: true,
      });
      aliceId = alice.id;
      const colin = await fx.user('list05-colin', {
        firstName: 'Colin',
        isActive: false,
      });
      colinId = colin.id;
    });

    it('Test 1 — default list omits the dismissed employee, keeps the active one [GREEN: characterization]', async () => {
      const res = await list({ pageSize: 100 });
      expect(res.status).toBe(200);
      const ids = itemsOf(res.body).map((u) => u.id);
      expect(ids).toContain(aliceId);
      expect(ids).not.toContain(colinId);
    });

    it('Test 2 — ?employmentStatus=dismissed surfaces the dismissed employee [RED: employmentStatus predicate not implemented]', async () => {
      const res = await list({ employmentStatus: 'dismissed', pageSize: 100 });
      expect(res.status).toBe(200);
      const items = itemsOf(res.body);
      expect(items.map((u) => u.id)).toContain(colinId);
      for (const item of items) {
        expect(item.employmentStatus ?? 'dismissed').toBe('dismissed');
      }
    });

    it('Test 3 — ?isActive=false is not a public predicate: ignored or rejected, never "a list of inactive rows" [RED: isActive is an accepted filter today]', async () => {
      const res = await list({ isActive: 'false', pageSize: 100 });
      const rejected = res.status === 400 || res.status === 422;
      const leakedInactiveRow = itemsOf(res.body).some((u) => u.id === colinId);
      // Target: either the param is rejected, or it is ignored (the dismissed
      // row must NOT be surfaced by it). Today: 200 + Colin present -> RED.
      expect(rejected || !leakedInactiveRow).toBe(true);
    });
  });
});
