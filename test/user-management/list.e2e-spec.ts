import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/list/um-list-01..04.md
// um-list-04 filters on scoped-per-run values (emailFor/ttId-with-runId)
// rather than the doc's literal canonical-fixture values
// (colin@company.example / tt-1042) — same run-isolation convention the
// rest of this file already uses, so this file's own runs never collide
// with another concurrent run or file. The deactivated-exclusion scenario
// this slot used to cover now lives in deactivation.e2e-spec.ts's
// um-deact-02 (the doc file was renamed/replaced, not just edited).
// Preconditions this suite can produce (several users existing with
// specific field combinations) are fulfilled with real POST /users
// requests, not hardcoded ids — see
// .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed.
//
// The exact pagination-envelope contract (page/pageSize/total field names)
// isn't fixed yet — api-conventions.md documents the filter query params
// but not the response shape. um-list-01's assertion stays permissive
// (results array + *some* count/page metadata), the same way auth's specs
// stay permissive about the session-token field name until one is settled.
describe('User list — GET /users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const runId = `e2e-${Date.now()}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (
    overrides: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('authorization', 'Bearer <token:Root>')
      .send({
        firstName: 'Fixture',
        lastName: 'Person',
        position: 'Engineer',
        country: 'Poland',
        city: 'Warsaw',
        companyJoinDate: '2024-01-01',
        ...overrides,
      });
    return res.body as Record<string, unknown>;
  };

  const resultsOf = (body: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(body)) {
      return body as Array<Record<string, unknown>>;
    }
    const envelope = body as Record<string, unknown>;
    const results = envelope.data ?? envelope.items ?? envelope.results;
    return (results ?? []) as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { workEmail: { contains: runId } },
    });
    await app.close();
  });

  describe('um-list-01 · list users returns pagination metadata', () => {
    it('returns a page of results plus pagination metadata', async () => {
      // Fixed at 15 (well past a page size of 10) so this holds regardless
      // of how many other rows exist from concurrent test-file runs.
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          createUser({ workEmail: emailFor(`page-${i}`) }),
        ),
      );

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ page: 1, pageSize: 10 })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Record<string, unknown>;
      const results = resultsOf(body);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(10);

      const metadata =
        body.total ??
        body.totalCount ??
        (body.meta as Record<string, unknown> | undefined)?.total ??
        (body.pagination as Record<string, unknown> | undefined)?.total;
      expect(metadata).toBeDefined();
    });
  });

  describe('um-list-02 · list users filtered by country', () => {
    it('returns only Poland users when filtering by country', async () => {
      await createUser({
        workEmail: emailFor('poland-list-02'),
        country: 'Poland',
      });
      await createUser({
        workEmail: emailFor('germany-list-02'),
        country: 'Germany',
      });

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ country: 'Poland' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.country).toBe('Poland');
      }
    });
  });

  describe('um-list-03 · list users with compound filters', () => {
    it('returns only records matching both position and city', async () => {
      await createUser({
        workEmail: emailFor('match-list-03'),
        position: 'Engineer',
        city: 'Krakow',
      });
      await createUser({
        workEmail: emailFor('wrong-city-list-03'),
        position: 'Engineer',
        city: 'Warsaw',
      });
      await createUser({
        workEmail: emailFor('wrong-position-list-03'),
        position: 'QA Engineer',
        city: 'Krakow',
      });

      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ position: 'Engineer', city: 'Krakow' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.position).toBe('Engineer');
        expect(item.city).toBe('Krakow');
      }
    });
  });

  describe('um-list-04 · list users filtered by the remaining S1 identity fields', () => {
    const ttId = `tt-list-04-${runId}`;
    let aliceId: string;
    let colinId: string;

    beforeAll(async () => {
      const alice = await createUser({
        firstName: 'Alicja',
        lastName: 'Larsson',
        workEmail: emailFor('alicja-list-04'),
        birthDay: 15,
        birthMonth: 3,
        workPhone: '+48-11-222-3333',
        companyJoinDate: '2022-04-01',
      });
      aliceId = alice.id as string;

      const colin = await createUser({
        firstName: 'Colin',
        lastName: 'Baseline',
        workEmail: emailFor('colin-list-04'),
        ttId,
      });
      colinId = colin.id as string;

      // Contrast record: differs from Alice on every field under test below,
      // and shares birthDay (but not birthMonth) with her so Test 4 can
      // prove the compound filter excludes a partial match.
      await createUser({
        firstName: 'Zack',
        lastName: 'Zimmer',
        workEmail: emailFor('contrast-list-04'),
        birthDay: 15,
        birthMonth: 7,
        workPhone: '+48-99-888-7777',
        companyJoinDate: '2023-01-01',
      });
    });

    it('Test 1 — filter by lastName', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ lastName: 'Larsson' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.lastName).toBe('Larsson');
      }
    });

    it('Test 2 — filter by workEmail', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workEmail: emailFor('colin-list-04') })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.map((u) => u.id)).toEqual([colinId]);
    });

    it('Test 3 — filter by ttId', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ ttId })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.map((u) => u.id)).toEqual([colinId]);
    });

    it('Test 4 — compound filter by birthDay + birthMonth excludes a partial match', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ birthDay: 15, birthMonth: 3 })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.birthDay).toBe(15);
        expect(item.birthMonth).toBe(3);
      }
      expect(results.some((u) => u.id === aliceId)).toBe(true);
    });

    it('Test 5 — filter by firstName', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ firstName: 'Alicja' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.firstName).toBe('Alicja');
      }
    });

    it('Test 6 — filter by workPhone', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ workPhone: '+48-11-222-3333' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.workPhone).toBe('+48-11-222-3333');
      }
    });

    it('Test 7 — filter by companyJoinDate', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ companyJoinDate: '2022-04-01' })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const results = resultsOf(res.body);
      expect(results.length).toBeGreaterThan(0);
      for (const item of results) {
        expect(item.companyJoinDate).toBe('2022-04-01');
      }
    });
  });
});
