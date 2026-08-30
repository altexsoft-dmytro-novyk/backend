import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import { establishSession } from '../fixtures/magic-link';
import {
  attachPolicyToUser,
  cleanupRun,
  createDepartment,
  createSeededUser,
  detachPolicyFromUser,
  ensureHrAdminPolicy,
  newRunId,
  writeJoinedCompanyEvent,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/seed/um-seed-01..03.md
//
// um-seed-01/03's own stateChange step is explicit that running the
// population import script is NOT an HTTP-driven event (see
// docs/test-cases/user-management/README.md, "Deliberately not covered
// here": seed-script bootstrap itself is out of scope for HTTP scenarios).
// The import script itself (prisma/seed.ts + its real data source) is out
// of this task's scope to build (services/backend/prisma/** is off-limits
// here, and no such script exists yet). This suite instead seeds
// User/UserEvents/UserPolicy rows directly via Prisma
// (../fixtures/seed-data.ts), shaped exactly as Story 1.1 promises the real
// import script will produce, then asserts the *observable* outcome
// through the real endpoints (GET /users/:id, GET /users/:id/events,
// GET /roles, POST /users). None of the read/roles routes exist yet
// (empty module scaffolds — see src/user-management/user-management.module.ts),
// so this suite is red because those endpoints are unimplemented, not
// because the seed step itself is faked.
//
// Reading back seeded data requires an authenticated session, which in turn
// requires Epic 2 (magic-link) to actually exist — establishSession mints a
// real token via Prisma and consumes it through the real
// POST /auth/magic-link/consume endpoint this task also builds (see
// ../auth/auth.e2e-spec.ts). Until that endpoint is implemented, tests here
// fail at the session-bootstrap step; that is the correct red reason for a
// story that structurally depends on Epic 2's session mechanism.
describe('Population seed/import — observable effects (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('seed');

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  describe('um-seed-01 · import creates User rows and a joined_company event', () => {
    it('Test 1 — S1 fields observable via Self read', async () => {
      const dept = await createDepartment(prisma, runId);
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-seed01',
        dept.id,
        {
          position: 'Engineer',
          country: 'Poland',
          city: 'Warsaw',
          workPhone: '+48-111-222-333',
          birthDay: 12,
          birthMonth: 4,
          companyJoinDate: new Date('2023-05-10'),
          ttId: `${runId}-tt-alice01`,
        },
      );

      const sessionToken = await establishSession(app, prisma, alice.id);

      const res = await request(app.getHttpServer())
        .get(`/users/${alice.id}`)
        .set('authorization', `Bearer ${sessionToken}`)
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.firstName).toBe(alice.firstName);
      expect(body.lastName).toBe(alice.lastName);
      expect(body.position).toBe('Engineer');
      expect(body.country).toBe('Poland');
      expect(body.city).toBe('Warsaw');
      expect(body.workEmail).toBe(alice.workEmail);
      expect(body.workPhone).toBe('+48-111-222-333');
      expect(body.birthDay).toBe(12);
      expect(body.birthMonth).toBe(4);
      expect(
        new Date(body.companyJoinDate as string).toISOString().slice(0, 10),
      ).toBe('2023-05-10');
      // FR-15: ttId and isActive are technical/internal — never
      // public/self-facing fields. Absence means the key is missing, not
      // null (docs/test-cases/README.md's "Absence is absence" rule).
      expect(body).not.toHaveProperty('ttId');
      expect(body).not.toHaveProperty('isActive');
    });

    it('Test 2 — joined_company event observable via Self timeline read', async () => {
      const dept = await createDepartment(prisma, runId);
      const companyJoinDate = new Date('2022-02-02');
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-seed01b',
        dept.id,
        { companyJoinDate },
      );
      await writeJoinedCompanyEvent(
        prisma,
        alice.id,
        companyJoinDate,
        alice.id,
      );

      const sessionToken = await establishSession(app, prisma, alice.id);

      const res = await request(app.getHttpServer())
        .get(`/users/${alice.id}/events`)
        .set('authorization', `Bearer ${sessionToken}`)
        .expect(200);

      // GET /users/:id/events wraps its list under `careertimeline` — the
      // shape already established (and depended on by all 181 of
      // access-control's own green E2E tests, e.g.
      // test/access-control/matrix/*/*.e2e-spec.ts's
      // `toHaveProperty('careertimeline')`) before this file was written.
      // Unwrapping here rather than changing that shape, per this task's
      // instruction not to invent a second, incompatible contract.
      const events = (
        res.body as { careertimeline: Array<Record<string, unknown>> }
      ).careertimeline;
      const joinedEvents = events.filter((e) => e.type === 'joined_company');
      expect(joinedEvents).toHaveLength(1);
      expect(joinedEvents[0].source).toBe('system');
      expect(
        new Date(joinedEvents[0].eventDate as string)
          .toISOString()
          .slice(0, 10),
      ).toBe('2022-02-02');
    });
  });

  describe('um-seed-02 · no HTTP create path for User', () => {
    it('Test 1 — unauthenticated POST /users returns 404, not 401', async () => {
      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', '')
        .send({
          firstName: 'Nina',
          lastName: 'New',
          workEmail: `${runId}-nina-new@company.example`,
        })
        .expect(404);
    });

    it('Test 2 — HR Admin POST /users still returns 404 and creates no row', async () => {
      const dept = await createDepartment(prisma, runId);
      const root = await createSeededUser(
        prisma,
        runId,
        'Root-seed02',
        dept.id,
      );
      const hrAdmin = await ensureHrAdminPolicy(prisma);
      await attachPolicyToUser(prisma, root.id, hrAdmin.id);

      const sessionToken = await establishSession(app, prisma, root.id);

      const workEmail = `${runId}-nina-new-root@company.example`;
      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', `Bearer ${sessionToken}`)
        .send({ firstName: 'Nina', lastName: 'New', workEmail })
        .expect(404);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();

      // This attachment to the shared, name-idempotent 'HR Admin' policy
      // (ensureHrAdminPolicy) only existed to pass the session's permission
      // gate for this Test's own POST /users probe — detach it so
      // um-seed-03's holder-count assertion, later in this same file run,
      // sees only its own fixture's attachment.
      await detachPolicyFromUser(prisma, root.id, hrAdmin.id);
    });
  });

  describe('um-seed-03 · import assigns exactly one bootstrap HR Admin', () => {
    it('the role catalog shows exactly one HR Admin holder, matching the bootstrap user', async () => {
      const dept = await createDepartment(prisma, runId);
      const root = await createSeededUser(
        prisma,
        runId,
        'Root-seed03',
        dept.id,
      );
      const hrAdmin = await ensureHrAdminPolicy(prisma);
      await attachPolicyToUser(prisma, root.id, hrAdmin.id);

      const sessionToken = await establishSession(app, prisma, root.id);

      const res = await request(app.getHttpServer())
        .get('/roles')
        .set('authorization', `Bearer ${sessionToken}`)
        .expect(200);

      // Assumption, documented for AD-1 review: no /roles response DTO is
      // fixed anywhere in the read artifacts (api-conventions.md only names
      // the route; ac-fc-03's scenario only says "role catalog readable
      // with HR Admin FR"). This test assumes each catalog entry is shaped
      // { id, name, holderCount, holders: [{ id, workEmail }] } — the
      // minimum shape that lets this scenario's own wording ("holder count
      // is exactly 1, and that holder is... matched by workEmail") be
      // asserted at all. Adjust this test if stage 3 fixes a different
      // shape.
      const policies = res.body as Array<{
        name: string;
        holderCount: number;
        holders: Array<{ id: string; workEmail: string }>;
      }>;
      const hrAdminEntry = policies.find((p) => p.name === 'HR Admin');
      expect(hrAdminEntry).toBeDefined();
      expect(hrAdminEntry?.holderCount).toBe(1);
      expect(hrAdminEntry?.holders?.[0]?.workEmail).toBe(root.workEmail);
    });
  });
});
