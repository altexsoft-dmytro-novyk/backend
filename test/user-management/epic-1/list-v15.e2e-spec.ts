import request from 'supertest';
import {
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
  seedCurrentEmploymentStatus,
} from './fixtures';
import { AccessControlFacade } from '../../../src/access-control/application/access-control.facade';
import {
  ACCESS_CONTROL_PORT,
  type AccessControlPort,
} from '../../../src/user-management/domain/interfaces/access-control.port';

/**
 * Epic 1 — Story 1.5 (List Employees with Pagination and Filters) · AD-1 Stage 2.
 *
 * One `it()` per approved Stage-1 scenario, id in the title:
 *   docs/test-cases/user-management/list/
 *     um-list-01-pagination-and-metadata.md
 *     um-list-02-filter-country.md
 *     um-list-03-compound-filters.md
 *     um-list-04-filter-remaining-identity-fields.md
 *     um-list-05-dismissed-hidden-by-default.md
 *     um-list-06-dismissed-findable-via-authorized-filter.md
 *     um-list-07-endpoint-authorization.md
 *     um-list-08-fixed-fail-closed-projection.md
 *     um-list-09-unsafe-and-unknown-filters-rejected.md
 *     um-list-10-empty-result-set.md
 *     um-list-11-deterministic-default-sort.md
 *     um-list-12-perf-nfr2-stage2-note.md
 *
 * This file replaces the pre-decisions scaffold (`um-list-01..05` describe
 * blocks + their old filenames) — it is re-derived from the approved
 * `um-list-*` files and the accepted decisions (AUTONOMOUS-RUN-LOG Story 1.5;
 * epic-1-approvals.yaml `1-5-list-employees-scenarios`): offset envelope
 * `{items,page,pageSize,total,totalPages}`, default pageSize 25 / max 100,
 * 13-key fixed projection (12 S1-card fields + `employmentStatus`), status
 * filter `?employmentStatus=active|dismissed` (absent → active only),
 * `forbidNonWhitelisted:true` → 400 on unknown/unsafe params, default sort
 * `lastName,firstName,id`, `?sort=` → 400.
 *
 * ── AD-3 ──────────────────────────────────────────────────────────────────
 * Real `AppModule`, real Prisma / migrated PostgreSQL, NO provider overrides.
 * The `um-list-12` call-count check uses `jest.spyOn` on the already-resolved
 * singleton `ACCESS_CONTROL_PORT` binding + the real `AccessControlFacade` —
 * observation of the real instances, not a rebind — and restores immediately.
 *
 * `bearer('Root')` resolves through `InterimSessionResolverAdapter` to the
 * most-recent real `HR Admin` `User`; under the real `AccessControlFacade`
 * (UMAC-1) only a live FR grant chain grants `user-management:list`, so the
 * suite seeds that chain for a fresh HR-Admin row in `beforeAll` (mirrors
 * access-control-adoption/no-target-permission.e2e-spec.ts Test 1). Every
 * employee row under test is a real Prisma insert with a per-run country tag
 * (`fx.runId`) so filtered totals / pagination / sort assertions are exact and
 * isolated — there is no `POST /users` in v1.5.
 *
 * ── Why RED today (interim `GET /users` vs the Story 1.5 target) ───────────
 * The interim handler returns `toUserResponse` (whole `User` row — leaks
 * `ttId`/`isActive`/`customFields`/`createdAt`/`createdBy`, no `employmentStatus`
 * key), accepts `ttId` / `isActive` filters, `whitelist:true` silently strips
 * unknown params (no 400), filters `isActive` for "dismissed" (Story 1.1
 * dismissed rows are `isActive:true`, so they are NOT hidden), sorts by
 * `createdAt`, defaults pageSize to 10, and omits `totalPages`. Per-test
 * headers below say which assertions are already GREEN characterization and
 * which are committed-red until Stage 3.
 */

const ROOT = bearer('Root');

// um-list-08 — the exact, fail-closed 13-key list-row projection.
const PROJECTION_KEYS = [
  'id',
  'firstName',
  'lastName',
  'photo',
  'position',
  'country',
  'city',
  'workEmail',
  'workPhone',
  'birthDay',
  'birthMonth',
  'companyJoinDate',
  'employmentStatus',
] as const;

// Keys a list row must NEVER carry (internal columns + derived audience-dependent
// fields — per-row projection/audience resolution is deferred, deferred-work §3.3.1).
const FORBIDDEN_ROW_KEYS = [
  'ttId',
  'isActive',
  'customFields',
  'createdAt',
  'createdBy',
  'canEdit',
  'manager',
  'peoplePartner',
  'department',
  'projects',
  'mentor',
] as const;

interface Envelope {
  items: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const asEnvelope = (body: unknown): Envelope => body as Envelope;
const idsOf = (body: unknown): string[] =>
  (asEnvelope(body).items ?? []).map((r) => r.id as string);

describe('Epic 1 · Story 1.5 — GET /users list/paginate/filter (e2e)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;
  // Seeded root + its FR grant chain — lives for the whole suite.
  let rootFx: RunFixtures;

  const listReq = () => request(testApp.app.getHttpServer()).get('/users');
  const list = (query: Record<string, unknown>, token: string = ROOT) =>
    listReq().query(query).set('authorization', token);

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
    rootFx = new RunFixtures(testApp.prisma);
    const root = await rootFx.user('list-v15-root', { position: 'HR Admin' });
    await rootFx.grantFunctionalRole(root.id);
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fx.cleanup();
  });

  afterAll(async () => {
    try {
      await testApp.prisma.user.deleteMany({
        where: { workEmail: { startsWith: 'interim-root-' } },
      });
    } catch (error) {
      console.warn('[list-v15] interim-root sweep failed', error);
    }
    await rootFx.cleanup();
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-01 · one page + full pagination metadata
  //   RED: `totalPages` is absent from `PaginatedResponseDto`; default pageSize
  //        is 10, not 25.  GREEN: page/pageSize echo, `total`, disjoint slices,
  //        `pageSize=101` → 400 (`@Max(100)`).
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-01 · pagination and metadata', () => {
    let tag: string;

    beforeEach(async () => {
      tag = fx.runId;
      await Promise.all(
        Array.from({ length: 26 }, (_, i) =>
          fx.user(`l01-${i}`, { country: tag }),
        ),
      );
    });

    it('Test 1 — first page carries a bounded slice + full metadata [RED: no totalPages]', async () => {
      const res = await list({ country: tag, page: 1, pageSize: 25 });
      expect(res.status).toBe(200);
      const body = asEnvelope(res.body);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageSize');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('totalPages');
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items.length).toBeLessThanOrEqual(25);
      expect(Number(body.page)).toBe(1);
      expect(Number(body.pageSize)).toBe(25);
      expect(Number(body.total)).toBe(26);
      expect(Number(body.totalPages)).toBe(Math.ceil(26 / 25));
    });

    it('Test 2 — second page is a disjoint slice, same total/totalPages [RED: no totalPages]', async () => {
      const p1 = await list({ country: tag, page: 1, pageSize: 25 });
      const p2 = await list({ country: tag, page: 2, pageSize: 25 });
      expect(p1.status).toBe(200);
      expect(p2.status).toBe(200);
      expect(Number(asEnvelope(p2.body).page)).toBe(2);
      const p1ids = new Set(idsOf(p1.body));
      const p2ids = idsOf(p2.body);
      expect(p2ids.length).toBe(1);
      for (const id of p2ids) expect(p1ids.has(id)).toBe(false);
      expect(Number(asEnvelope(p2.body).total)).toBe(26);
      expect(Number(asEnvelope(p2.body).totalPages)).toBe(Math.ceil(26 / 25));
    });

    it('Test 3 — pageSize over the cap is rejected [GREEN: @Max(100)]', async () => {
      const res = await list({ pageSize: 101 });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/pageSize/i);
      expect(res.body).not.toHaveProperty('items');
    });

    it('Test 4 — omitting params applies defaults page=1, pageSize=25 [RED: default pageSize is 10]', async () => {
      const res = await list({});
      expect(res.status).toBe(200);
      expect(Number(asEnvelope(res.body).page)).toBe(1);
      expect(Number(asEnvelope(res.body).pageSize)).toBe(25);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-02 · filter by a single identity field (country)
  //   GREEN characterization — `?country=` is already a working equality filter.
  // ───────────────────────────────────────────────────────────────────────
  it('um-list-02 · ?country=Poland → every row country==="Poland", exact equality [GREEN: characterization]', async () => {
    const tag = fx.runId;
    const pl1 = await fx.user('l02-pl1', { country: 'Poland', position: tag });
    const pl2 = await fx.user('l02-pl2', { country: 'Poland', position: tag });
    const de = await fx.user('l02-de', { country: 'Germany', position: tag });

    const res = await list({ country: 'Poland', position: tag, pageSize: 100 });
    expect(res.status).toBe(200);
    const items = asEnvelope(res.body).items;
    expect(items.length).toBe(2);
    for (const item of items) expect(item.country).toBe('Poland');
    const ids = items.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([pl1.id, pl2.id]));
    expect(ids).not.toContain(de.id);
    expect(Number(asEnvelope(res.body).total)).toBe(2);
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-03 · combined filters (position + city), AND semantics, NULL never matches
  //   GREEN characterization — compound equality + Prisma's `NULL`-excludes-equality.
  // ───────────────────────────────────────────────────────────────────────
  it('um-list-03 · ?position=Engineer&city=Krakow → AND match; null-city row never appears [GREEN: characterization]', async () => {
    const tag = fx.runId;
    const hit = await fx.user('l03-hit', {
      position: 'Engineer',
      city: 'Krakow',
      country: tag,
    });
    const wrongCity = await fx.user('l03-warsaw', {
      position: 'Engineer',
      city: 'Warsaw',
      country: tag,
    });
    const wrongPos = await fx.user('l03-qa', {
      position: 'QA Engineer',
      city: 'Krakow',
      country: tag,
    });
    const nullCity = await fx.user('l03-nullcity', {
      position: 'Engineer',
      country: tag,
    });
    await testApp.prisma.user.update({
      where: { id: nullCity.id },
      data: { city: null },
    });

    const res = await list({
      position: 'Engineer',
      city: 'Krakow',
      country: tag,
      pageSize: 100,
    });
    expect(res.status).toBe(200);
    const items = asEnvelope(res.body).items;
    expect(items.length).toBe(1);
    for (const item of items) {
      expect(item.position).toBe('Engineer');
      expect(item.city).toBe('Krakow');
    }
    const ids = items.map((r) => r.id);
    expect(ids).toContain(hit.id);
    expect(ids).not.toContain(wrongCity.id);
    expect(ids).not.toContain(wrongPos.id);
    expect(ids).not.toContain(nullCity.id);
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-04 · breadth over the remaining permission-safe S1 filters
  //   GREEN characterization — each field is already a working equality filter.
  //   (The projection tightening those rows still need is um-list-08's.)
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-04 · remaining permission-safe S1 filters [GREEN: characterization]', () => {
    let tag: string;
    let alice: Awaited<ReturnType<RunFixtures['user']>>;

    beforeEach(async () => {
      tag = fx.runId;
      alice = await fx.user('l04-alice', {
        firstName: 'Alicja',
        lastName: 'Larsson',
        birthDay: 15,
        birthMonth: 3,
        workPhone: '+48-11-222-3333',
        companyJoinDate: '2022-04-01',
        country: tag,
      });
      // Contrast: shares birthDay 15, differs on birthMonth (7).
      await fx.user('l04-contrast', {
        firstName: 'Zack',
        lastName: 'Zimmer',
        birthDay: 15,
        birthMonth: 7,
        workPhone: '+48-99-888-7777',
        companyJoinDate: '2023-01-01',
        country: tag,
      });
    });

    it('Test 1 — firstName', async () => {
      const res = await list({
        firstName: 'Alicja',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      for (const item of items) expect(item.firstName).toBe('Alicja');
    });

    it('Test 2 — lastName', async () => {
      const res = await list({
        lastName: 'Larsson',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      for (const item of items) expect(item.lastName).toBe('Larsson');
    });

    it('Test 3 — workEmail (unique → exactly one row)', async () => {
      const res = await list({ workEmail: alice.workEmail, pageSize: 100 });
      expect(res.status).toBe(200);
      expect(idsOf(res.body)).toEqual([alice.id]);
    });

    it('Test 4 — workPhone', async () => {
      const res = await list({
        workPhone: '+48-11-222-3333',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      for (const item of items) expect(item.workPhone).toBe('+48-11-222-3333');
    });

    it('Test 5 — compound birthDay + birthMonth excludes a partial match', async () => {
      const res = await list({
        birthDay: 15,
        birthMonth: 3,
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      for (const item of items) {
        expect(item.birthDay).toBe(15);
        expect(item.birthMonth).toBe(3);
      }
      expect(items.map((r) => r.id)).toContain(alice.id);
    });

    it('Test 6 — companyJoinDate', async () => {
      const res = await list({
        companyJoinDate: '2022-04-01',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      for (const item of items) expect(item.companyJoinDate).toBe('2022-04-01');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-05 · a dismissed employee drops out of the default list
  //   Test 1 GREEN characterization (both active → both present).
  //   Test 2 RED — the interim handler keys on `User.isActive` (still true for a
  //          Story-1.1 dismissal), so Colin is NOT hidden; there is no
  //          `EmploymentStatus` join.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-05 · dismissed hidden by default', () => {
    let tag: string;
    let aliceId: string;
    let colinId: string;

    beforeEach(async () => {
      tag = fx.runId;
      // Colin & Alice: both isActive:true, both currently `active` (no
      // EmploymentStatus row → treated active, README decision §6). Alice never
      // gets a row this scenario — it exercises the default-active fallback.
      const alice = await fx.user('l05-alice', {
        firstName: 'Alice',
        country: tag,
      });
      aliceId = alice.id;
      const colin = await fx.user('l05-colin', {
        firstName: 'Colin',
        country: tag,
      });
      colinId = colin.id;
    });

    it('Test 1 — baseline: the default list contains Colin and Alice [GREEN: characterization]', async () => {
      const res = await list({ country: tag, pageSize: 100 });
      expect(res.status).toBe(200);
      const ids = idsOf(res.body);
      expect(ids).toEqual(expect.arrayContaining([aliceId, colinId]));
    });

    it('Test 2 — after Colin is dismissed the default list omits him, keeps Alice [RED: no EmploymentStatus join, keys on isActive]', async () => {
      // stateChange — seed the dismissed fact directly (Epic 5 departure
      // workflow is CC-06-blocked, no HTTP surface). Colin.isActive stays true.
      await seedCurrentEmploymentStatus(testApp.prisma, colinId, 'dismissed', {
        validFrom: '2026-09-01',
      });
      const colinRow = await testApp.prisma.user.findUnique({
        where: { id: colinId },
      });
      expect(colinRow?.isActive).toBe(true);

      const res = await list({ country: tag, pageSize: 100 });
      expect(res.status).toBe(200);
      const ids = idsOf(res.body);
      expect(ids).toContain(aliceId);
      expect(ids).not.toContain(colinId);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-06 · a dismissed employee is findable via ?employmentStatus=dismissed
  //   RED — `employmentStatus` is not a `ListUsersQueryDto` field, so it is
  //   silently stripped today; no predicate, no projected key, and an unknown
  //   value is not rejected. The filter is gated by `user-management:list`
  //   alone (Root holds it; see um-list-07) — no separate capability.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-06 · dismissed findable via the authorized filter', () => {
    let tag: string;
    let aliceId: string;
    let colinId: string;

    beforeEach(async () => {
      tag = fx.runId;
      const alice = await fx.user('l06-alice', { country: tag });
      aliceId = alice.id;
      const colin = await fx.user('l06-colin', { country: tag });
      colinId = colin.id;
      await seedCurrentEmploymentStatus(testApp.prisma, aliceId, 'active');
      await seedCurrentEmploymentStatus(testApp.prisma, colinId, 'dismissed', {
        validFrom: '2026-09-01',
      });
    });

    it('Test 1 — ?employmentStatus=dismissed surfaces Colin, hides Alice, every row "dismissed" [RED]', async () => {
      const res = await list({
        employmentStatus: 'dismissed',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.map((r) => r.id)).toContain(colinId);
      expect(items.map((r) => r.id)).not.toContain(aliceId);
      for (const item of items) expect(item.employmentStatus).toBe('dismissed');
    });

    it('Test 2 — ?employmentStatus=active mirrors the default list [RED]', async () => {
      const res = await list({
        employmentStatus: 'active',
        country: tag,
        pageSize: 100,
      });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.map((r) => r.id)).toContain(aliceId);
      expect(items.map((r) => r.id)).not.toContain(colinId);
      for (const item of items) expect(item.employmentStatus).toBe('active');
    });

    it('Test 3 — ?employmentStatus=retired is rejected [RED: value not validated, param stripped today]', async () => {
      const res = await list({ employmentStatus: 'retired' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/employmentStatus/i);
      expect(res.body).not.toHaveProperty('items');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-07 · endpoint is gated by the no-target user-management:list capability
  //   GREEN characterization — the real facade adapter + guard already enforce
  //   this exactly (Root FR grant → 200; unrelated FR → 403; no token → 401).
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-07 · endpoint authorization [GREEN: characterization]', () => {
    it('Test 1 — entitled caller (Root, live hr-admin FR grant) → 200 envelope', async () => {
      const res = await list({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('pageSize');
      expect(res.body).toHaveProperty('total');
    });

    it('Test 2 — authenticated caller without the capability (Ida, unrelated FR) → 403, leak-free', async () => {
      const ida = await fx.user('l07-ida', { position: 'Engineer' });
      await fx.grantFunctionalRole(ida.id, [`l07:unrelated-${fx.runId}`]);

      const res = await list({}, bearer(ida.id));
      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('items');
      expect(res.body).not.toHaveProperty('total');
      expect(res.body).not.toHaveProperty('page');
    });

    it('Test 3 — unauthenticated caller → 401, no list data', async () => {
      const res = await listReq().query({});
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('items');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-08 · every list row is the same fixed, fail-closed 13-key projection
  //   RED — the interim handler spreads the whole `User` row (extra keys) and
  //   has no `employmentStatus` key at all.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-08 · fixed fail-closed projection [RED]', () => {
    let tag: string;
    let nullUserEmail: string;

    beforeEach(async () => {
      tag = fx.runId;
      // A fully-populated row.
      await fx.user('l08-full', {
        photo: 'https://photos.example/l08-full.jpg',
        workPhone: '+48 111 222 333',
        birthDay: 12,
        birthMonth: 6,
        city: 'Krakow',
        country: tag,
      });
      // A row whose every nullable field is null.
      const nullUser = await fx.user('l08-null', {
        photo: null,
        workPhone: null,
        birthDay: null,
        birthMonth: null,
        country: tag,
      });
      nullUserEmail = nullUser.workEmail;
      await testApp.prisma.user.update({
        where: { id: nullUser.id },
        data: { city: null },
      });
    });

    it('Test 1 — every row has exactly the 13 projection keys, no others', async () => {
      const res = await list({ country: tag, pageSize: 100 });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(2);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([...PROJECTION_KEYS].sort());
        for (const forbidden of FORBIDDEN_ROW_KEYS) {
          expect(item).not.toHaveProperty(forbidden);
        }
      }
    });

    it('Test 2 — nullable keys are present-but-null, not dropped; employmentStatus is "active"', async () => {
      const res = await list({ workEmail: nullUserEmail });
      expect(res.status).toBe(200);
      const items = asEnvelope(res.body).items;
      expect(items.length).toBe(1);
      const row = items[0];
      expect(Object.keys(row).sort()).toEqual([...PROJECTION_KEYS].sort());
      expect(row.photo).toBeNull();
      expect(row.workPhone).toBeNull();
      expect(row.city).toBeNull();
      expect(row.birthDay).toBeNull();
      expect(row.birthMonth).toBeNull();
      expect(row.employmentStatus).toBe('active');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-09 · internal & unknown filter predicates → 400, never silently applied
  //   RED — `ttId` / `isActive` are accepted `ListUsersQueryDto` fields today,
  //   and unknown keys are silently stripped (`whitelist:true`, not
  //   `forbidNonWhitelisted:true`).
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-09 · unsafe and unknown filters rejected [RED]', () => {
    let tag: string;

    beforeEach(async () => {
      tag = fx.runId;
      // A purged row and a row with a non-null ttId — so "rejected, not applied"
      // is observable (neither can be surfaced/excluded by the rejected param).
      await fx.user('l09-purged', { isActive: false, country: tag });
      await fx.user('l09-ttid', { ttId: `tt-l09-${fx.runId}`, country: tag });
    });

    it('Test 1 — ?ttId= is rejected (FR-15)', async () => {
      const res = await list({ ttId: `tt-l09-${fx.runId}` });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/ttId/i);
      expect(res.body).not.toHaveProperty('items');
    });

    it('Test 2 — ?isActive=false is rejected, not "a list of inactive rows" (FR-15)', async () => {
      const res = await list({ isActive: 'false' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/isActive/i);
      expect(res.body).not.toHaveProperty('items');
    });

    it('Test 3 — a field outside the fixed projection (?createdBy=) is rejected', async () => {
      const res = await list({
        createdBy: '00000000-0000-0000-0000-000000000000',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/createdBy/i);
      expect(res.body).not.toHaveProperty('items');
    });

    it('Test 4 — outright unknown keys (?q=&department=) are rejected', async () => {
      const res = await list({ q: 'alice', department: 'Engineering' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/q|department/i);
      expect(res.body).not.toHaveProperty('items');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-10 · a filter matching nothing → 200 + empty page + valid metadata
  //   RED only on `totalPages` (absent today). The 200 + `items:[]` + `total`
  //   parts are GREEN characterization.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-10 · empty result set', () => {
    it('Test 1 — no row matches (?country=Atlantis) → 200, items:[], total:0, totalPages:0 [RED: no totalPages]', async () => {
      const res = await list({
        country: `Atlantis-${fx.runId}`,
        page: 1,
        pageSize: 25,
      });
      expect(res.status).toBe(200);
      const body = asEnvelope(res.body);
      expect(body.items).toEqual([]);
      expect(Number(body.page)).toBe(1);
      expect(Number(body.pageSize)).toBe(25);
      expect(Number(body.total)).toBe(0);
      expect(res.body).toHaveProperty('totalPages');
      expect(Number(body.totalPages)).toBe(0);
    });

    it('Test 2 — page beyond the last page of a non-empty result → 200, items:[], real total [RED: no totalPages]', async () => {
      const tag = fx.runId;
      await fx.user('l10-solo', { country: tag });

      const res = await list({ country: tag, page: 9, pageSize: 25 });
      expect(res.status).toBe(200);
      const body = asEnvelope(res.body);
      expect(body.items).toEqual([]);
      expect(Number(body.page)).toBe(9);
      expect(Number(body.pageSize)).toBe(25);
      expect(Number(body.total)).toBe(1);
      expect(res.body).toHaveProperty('totalPages');
      expect(Number(body.totalPages)).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-11 · deterministic default sort (lastName, firstName, id); ?sort= → 400
  //   Test 1 RED — the interim handler sorts by `createdAt asc`.
  //   Test 2 GREEN characterization — `createdAt asc` is at least repeatable.
  //   Test 3 RED — `?sort=` is silently stripped today, not rejected.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-11 · deterministic default sort', () => {
    let tag: string;

    beforeEach(async () => {
      tag = fx.runId;
      // Inserted deliberately NOT in (lastName, firstName) order.
      await fx.user('l11-a', {
        lastName: 'Zieliński',
        firstName: 'Zofia',
        country: tag,
      });
      await fx.user('l11-b', {
        lastName: 'Adamczyk',
        firstName: 'Anna',
        country: tag,
      });
      await fx.user('l11-c', {
        lastName: 'Nowak',
        firstName: 'Bartek',
        country: tag,
      });
      await fx.user('l11-d', {
        lastName: 'Nowak',
        firstName: 'Agata',
        country: tag,
      });
    });

    it('Test 1 — default order is (lastName, firstName, id), stable across pages [RED: sorts by createdAt today]', async () => {
      const p1 = await list({ country: tag, page: 1, pageSize: 2 });
      const p2 = await list({ country: tag, page: 2, pageSize: 2 });
      expect(p1.status).toBe(200);
      expect(p2.status).toBe(200);

      const rows = [...asEnvelope(p1.body).items, ...asEnvelope(p2.body).items];
      expect(rows.length).toBe(4);
      // No id on both pages.
      const p1ids = new Set(idsOf(p1.body));
      for (const id of idsOf(p2.body)) expect(p1ids.has(id)).toBe(false);
      // Non-decreasing (lastName, firstName, id).
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const key = (r: Record<string, unknown>) =>
          `${r.lastName as string} ${r.firstName as string} ${r.id as string}`;
        expect(key(prev) <= key(cur)).toBe(true);
      }
      expect(rows.map((r) => r.lastName)).toEqual([
        'Adamczyk',
        'Nowak',
        'Nowak',
        'Zieliński',
      ]);
      // firstName tiebreak within the same lastName, id tiebreak last.
      expect(rows[1].firstName).toBe('Agata');
      expect(rows[2].firstName).toBe('Bartek');
    });

    it('Test 2 — the same request twice yields the same order [GREEN: characterization]', async () => {
      const a = await list({ country: tag, pageSize: 100 });
      const b = await list({ country: tag, pageSize: 100 });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(idsOf(a.body)).toEqual(idsOf(b.body));
    });

    it('Test 3 — ?sort=lastName is rejected [RED: silently stripped today]', async () => {
      const res = await list({ sort: 'lastName' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/sort/i);
      expect(res.body).not.toHaveProperty('items');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // um-list-12 · NFR-2 perf note
  //   Test 1 (call count) — checkable now via jest.spyOn on the real
  //     ACCESS_CONTROL_PORT singleton + the real AccessControlFacade (no
  //     rebind). Likely GREEN characterization today (the handler already makes
  //     exactly one no-target isAllowed call and zero per-row calls) — it locks
  //     in the forward "single bulk resolveAudiences, never N+1" constraint.
  //   Test 2 (wall-clock, 500+ rows, <2s) — deferred @perf, see it.todo below.
  // ───────────────────────────────────────────────────────────────────────
  describe('um-list-12 · perf / no per-row facade calls', () => {
    it('Test 1 — the list handler makes exactly one facade call (isAllowed), zero per-row calls', async () => {
      await fx.user('l12-1', { country: 'Poland', position: 'Engineer' });
      await fx.user('l12-2', { country: 'Poland', position: 'Engineer' });

      const port = testApp.app.get<AccessControlPort>(ACCESS_CONTROL_PORT);
      const facade = testApp.app.get(AccessControlFacade, { strict: false });

      const isAllowedSpy = jest.spyOn(port, 'isAllowed');
      // PLAT-E4-S4.1d (2026-09-06): the `isAllowedForTarget` spy and its
      // `not.toHaveBeenCalled()` assertion went with the port method itself
      // (AF-1, PO ruling 2026-09-06). The constraint they pinned is now
      // statically guaranteed — the method no longer exists to be called.
      // The N+1 guard below is unchanged.
      const resolveAudiencesSpy = jest.spyOn(facade, 'resolveAudiences');
      const canAccessSectionSpy = jest.spyOn(facade, 'canAccessSection');

      const res = await list({
        country: 'Poland',
        position: 'Engineer',
        page: 1,
        pageSize: 25,
      });
      expect(res.status).toBe(200);

      expect(isAllowedSpy).toHaveBeenCalledTimes(1);
      expect(isAllowedSpy.mock.calls[0][1]).toBe('user-management:list');
      expect(resolveAudiencesSpy).not.toHaveBeenCalled();
      expect(canAccessSectionSpy).not.toHaveBeenCalled();
    });

    // Deferred: wall-clock NFR-2 (500+ rows, arbitrary filters, <2000ms including
    // authorization). Belongs in a dedicated @perf/load spec seeded to 500+ rows
    // (or the deferred-work §3.3.1 projection suite that owns the §7 budget) —
    // not this behavioural Stage-2 file. README decision §14.
    it.todo(
      'um-list-12 Test 2 — @perf: 500+ rows + arbitrary filters resolve within 2000ms (deferred to a dedicated perf spec)',
    );
  });
});
