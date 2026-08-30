import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import {
  cleanupRun,
  createDepartment,
  createSeededUser,
  markDismissed,
  newRunId,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/list/um-list-01..05.md — all
// five are alive/verified per the 2026-08-30 audit
// (docs/test-cases/user-management/README.md's Layout table).
//
// Rewritten from scratch (2026-08-30 architecture-reset audit) — same
// reasons as ../profile/profile.e2e-spec.ts's top-of-file note (POST
// /users retired, literal Bearer placeholders no longer authenticate).
//
// Deliberate deviation from um-list-04's Test 3 (filter by `ttId`): FR-15
// and epics.md Story 1.5's own scope note both state, in the same words
// twice, that `ttId`/`isActive` are "never public filters" — the scenario
// doc's Test 3 predates that rule being restated post-reset and conflicts
// with it. FR-15 is the higher-altitude, twice-stated source, so `ttId` is
// not implemented as a filter (see UsersController.list /
// ProfileDataRepository.listUsersPage's doc comments) and this suite does
// not test it. Every other um-list-04 field filter is covered.
describe('User list — GET /users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('list');
  let departmentId: string;
  let rootId: string;

  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;
  const itemsOf = (body: unknown): Array<Record<string, unknown>> =>
    (body as { items: Array<Record<string, unknown>> }).items;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    const dept = await createDepartment(prisma, runId);
    departmentId = dept.id;
    const root = await createSeededUser(
      prisma,
      runId,
      'Root-list',
      departmentId,
    );
    rootId = root.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  describe('um-list-01 · list users returns pagination metadata', () => {
    it('returns a page of results plus pagination metadata', async () => {
      // Fixed at 15 (well past a page size of 10) so this holds regardless
      // of how many other rows exist from concurrent test-file runs.
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          createSeededUser(prisma, runId, `Page${i}-list01`, departmentId),
        ),
      );

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ page: 1, pageSize: 10 })
        .set('authorization', bearer(rootId))
        .expect(200);

      const body = res.body as Record<string, unknown>;
      const results = itemsOf(body);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(10);
      expect(body.total).toBeDefined();
    });
  });

  describe('um-list-02 · list users filtered by country', () => {
    it('returns only Poland users when filtering by country', async () => {
      await createSeededUser(prisma, runId, 'Poland-list02', departmentId, {
        country: 'Poland',
      });
      await createSeededUser(prisma, runId, 'Germany-list02', departmentId, {
        country: 'Germany',
      });

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ country: 'Poland' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) expect(item.country).toBe('Poland');
    });
  });

  describe('um-list-03 · list users with compound filters', () => {
    it('returns only records matching both position and city', async () => {
      await createSeededUser(prisma, runId, 'Match-list03', departmentId, {
        position: 'Engineer',
        city: 'Krakow',
      });
      await createSeededUser(prisma, runId, 'WrongCity-list03', departmentId, {
        position: 'Engineer',
        city: 'Warsaw',
      });
      await createSeededUser(prisma, runId, 'WrongPos-list03', departmentId, {
        position: 'QA Engineer',
        city: 'Krakow',
      });

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ position: 'Engineer', city: 'Krakow' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.position).toBe('Engineer');
        expect(item.city).toBe('Krakow');
      }
    });
  });

  describe('um-list-04 · list users filtered by the remaining S1 identity fields', () => {
    let aliceId: string;
    let colinId: string;

    beforeAll(async () => {
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alicja-list04',
        departmentId,
        {
          firstName: 'Alicja',
          lastName: 'Larsson',
          birthDay: 15,
          birthMonth: 3,
          workPhone: '+48-11-222-3333',
          companyJoinDate: new Date('2022-04-01'),
        },
      );
      aliceId = alice.id;

      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-list04',
        departmentId,
        { lastName: 'Baseline' },
      );
      colinId = colin.id;

      // Contrast record: differs from Alice on every field under test,
      // shares birthDay (not birthMonth) so Test 4 can prove the compound
      // filter excludes a partial match.
      await createSeededUser(prisma, runId, 'Zack-list04', departmentId, {
        firstName: 'Zack',
        lastName: 'Zimmer',
        birthDay: 15,
        birthMonth: 7,
        workPhone: '+48-99-888-7777',
        companyJoinDate: new Date('2023-01-01'),
      });
    });

    it('Test 1 — filter by lastName', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ lastName: 'Larsson' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) expect(item.lastName).toBe('Larsson');
    });

    it('Test 2 — filter by workEmail', async () => {
      const colin = await prisma.user.findUniqueOrThrow({
        where: { id: colinId },
      });
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workEmail: colin.workEmail })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.map((u) => u.id)).toEqual([colinId]);
    });

    it('Test 3 — compound filter by birthDay + birthMonth excludes a partial match', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ birthDay: 15, birthMonth: 3 })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.birthDay).toBe(15);
        expect(item.birthMonth).toBe(3);
      }
      expect(results.some((u) => u.id === aliceId)).toBe(true);
    });

    it('Test 4 — filter by firstName', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ firstName: 'Alicja' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) expect(item.firstName).toBe('Alicja');
    });

    it('Test 5 — filter by workPhone', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workPhone: '+48-11-222-3333' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.workPhone).toBe('+48-11-222-3333');
      }
    });

    it('Test 6 — filter by companyJoinDate', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ companyJoinDate: '2022-04-01' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(
          new Date(item.companyJoinDate as string).toISOString().slice(0, 10),
        ).toBe('2022-04-01');
      }
    });
  });

  describe('um-list-05 · dismissed employees excluded by default, findable via filter', () => {
    let colinId: string;

    beforeAll(async () => {
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-list05',
        departmentId,
      );
      colinId = colin.id;
      await markDismissed(prisma, colin.id);
    });

    it('Test 1 — default list excludes Colin', async () => {
      const colin = await prisma.user.findUniqueOrThrow({
        where: { id: colinId },
      });
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workEmail: colin.workEmail })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.some((u) => u.id === colinId)).toBe(false);
    });

    it('Test 2 — explicit employment-status filter finds Colin', async () => {
      const colin = await prisma.user.findUniqueOrThrow({
        where: { id: colinId },
      });
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workEmail: colin.workEmail, employmentStatus: 'dismissed' })
        .set('authorization', bearer(rootId))
        .expect(200);

      const results = itemsOf(res.body);
      expect(results.some((u) => u.id === colinId)).toBe(true);
      const found = results.find((u) => u.id === colinId);
      expect(found?.employmentStatus).toBe('dismissed');
    });
  });
});
