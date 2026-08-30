import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { DepartureExecutorService } from '../../../src/user-management/infrastructure/departure-executor.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import {
  attachPolicyToUser,
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createSeededUser,
  ensurePolicyWithPermission,
  newRunId,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/departure/um-dep-01..06.md
// (Epic 5, Stories 5.1/5.2). The executor's sweep is clock-driven — no HTTP
// endpoint triggers it — so per nest-e2e.md's "closest real substitute"
// convention, these tests call the same DepartureExecutorService.runOnce()
// the @Cron hook calls, resolved straight off the real Nest app's DI
// container, rather than waiting on real time to pass.
describe('Employment lifecycle — Epic 5 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('dep');
  let departmentId: string;

  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;
    const dept = await createDepartment(prisma, runId);
    departmentId = dept.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  async function makeRootWithPermission(persona: string): Promise<string> {
    const root = await createSeededUser(prisma, runId, persona, departmentId);
    const policy = await ensurePolicyWithPermission(
      prisma,
      `${runId}-record-departure-policy`,
      'record a departure',
    );
    await attachPolicyToUser(prisma, root.id, policy.id);
    return root.id;
  }

  describe('um-dep-01 · record a future departure', () => {
    it('stores the Departure row without flipping current status', async () => {
      const rootId = await makeRootWithPermission('Root-dep01');
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-dep01',
        departmentId,
      );

      const res = await request(app.getHttpServer())
        .post(`/users/${colin.id}/departure`)
        .set('authorization', bearer(rootId))
        .send({ effectiveDate: '2099-01-01', reason: 'resignation' })
        .expect(201);

      expect(res.body).toMatchObject({
        userId: colin.id,
        reason: 'resignation',
        appliedAt: null,
      });

      // S4 (employment) is colleague:none in the base matrix — Root has no
      // relationship to Colin here, so S4 read is unavailable to them. S1
      // (colleague:read) carries `employmentStatus` in its own body too
      // (users.controller.ts's getProfile), so that's the read this
      // assertion actually uses.
      const profile = await request(app.getHttpServer())
        .get(`/users/${colin.id}`)
        .set('authorization', bearer(rootId))
        .expect(200);
      expect(
        (profile.body as { employmentStatus: string }).employmentStatus,
      ).toBe('active');
    });
  });

  describe('um-dep-02 · blocked while the subject still manages relations', () => {
    it('rejects recording a departure for a still-active manager', async () => {
      const rootId = await makeRootWithPermission('Root-dep02');
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-dep02',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-dep02',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      await request(app.getHttpServer())
        .post(`/users/${bob.id}/departure`)
        .set('authorization', bearer(rootId))
        .send({ effectiveDate: '2099-01-01', reason: 'resignation' })
        .expect(409);

      const stored = await prisma.departure.findFirst({
        where: { userId: bob.id },
      });
      expect(stored).toBeNull();
    });
  });

  describe('um-dep-03 · without permission denied', () => {
    it('rejects Bob, who holds no record-a-departure policy', async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-dep03',
        departmentId,
      );
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-dep03',
        departmentId,
      );

      await request(app.getHttpServer())
        .post(`/users/${colin.id}/departure`)
        .set('authorization', bearer(bob.id))
        .send({ effectiveDate: '2099-01-01', reason: 'resignation' })
        .expect(403);

      const stored = await prisma.departure.findFirst({
        where: { userId: colin.id },
      });
      expect(stored).toBeNull();
    });
  });

  describe('um-dep-04/05 · executor applies the full bundle, then is idempotent on retry', () => {
    it('applies EmploymentStatus, isActive, action-item cancel, mentorship close — then a re-run is a no-op', async () => {
      const rootId = await makeRootWithPermission('Root-dep0405');
      const colin = await createSeededUser(
        prisma,
        runId,
        'Colin-dep0405',
        departmentId,
      );
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-dep0405',
        departmentId,
      );
      // S9 is colleague:none — give Root Reporting-line read access to
      // Colin so the career-timeline verification below isn't denied for
      // an unrelated reason. AD-17: a departed *target*'s existing readers
      // keep read access, so this survives the departure applied later.
      await createDirectEdge(prisma, colin.id, rootId);

      // stateChange: a due, unapplied Departure — clock-driven precondition,
      // written directly since no HTTP path can make a real one due today.
      await prisma.departure.create({
        data: {
          userId: colin.id,
          effectiveDate: new Date('2000-01-01'),
          reason: 'resignation',
          recordedBy: rootId,
        },
      });

      const actionItem = await prisma.sectionRecord.create({
        data: {
          userId: colin.id,
          section: 's14',
          data: {
            assigneeId: colin.id,
            title: 'Offboarding prep',
            status: 'open',
          },
          createdBy: rootId,
        },
      });

      const pair = await prisma.sectionRecord.create({
        data: {
          userId: nina.id,
          section: 's13',
          data: {
            kind: 'pair',
            mentorId: nina.id,
            menteeId: colin.id,
            status: 'active',
          },
          createdBy: rootId,
        },
      });

      const executor = app.get(DepartureExecutorService);
      const appliedCount = await executor.runOnce();
      expect(appliedCount).toBeGreaterThanOrEqual(1);

      // Test 1 — employment status dismissed (S1's colleague:read body, see
      // the um-dep-01 note above for why S4 isn't used here)
      const profile = await request(app.getHttpServer())
        .get(`/users/${colin.id}`)
        .set('authorization', bearer(rootId))
        .expect(200);
      expect(
        (profile.body as { employmentStatus: string }).employmentStatus,
      ).toBe('dismissed');

      // Test 2 — findable via the dismissed filter
      const list = await request(app.getHttpServer())
        .get(`/users?employmentStatus=dismissed`)
        .set('authorization', bearer(rootId))
        .expect(200);
      const items = (list.body as { items: Array<{ id: string }> }).items;
      expect(items.some((u) => u.id === colin.id)).toBe(true);

      // Test 3 — action item cancelled
      const cancelledItem = await prisma.sectionRecord.findUnique({
        where: { id: actionItem.id },
      });
      expect((cancelledItem?.data as Record<string, unknown>).status).toBe(
        'cancelled — departed',
      );

      // Test 4 — mentorship pair closed with a system note
      const closedPair = await prisma.sectionRecord.findUnique({
        where: { id: pair.id },
      });
      const pairData = closedPair?.data as Record<string, unknown>;
      expect(pairData.status).toBe('closed');
      expect(String(pairData.closureNote)).toMatch(/departed/i);

      // Test 5 — no departure event on the career timeline
      const events = await request(app.getHttpServer())
        .get(`/users/${colin.id}/events`)
        .set('authorization', bearer(rootId))
        .expect(200);
      const eventList = (
        events.body as { careertimeline: Array<{ type: string }> }
      ).careertimeline;
      expect(eventList.every((e) => !/departure/i.test(e.type))).toBe(true);

      // um-dep-05: re-running the executor is a no-op — exactly one open
      // dismissed EmploymentStatus row, applyNextDue finds nothing more due
      // for Colin (appliedAt now excludes this row from the claim).
      const secondRun = await executor.runOnce();
      expect(secondRun).toBe(0);

      const dismissedRows = await prisma.employmentStatus.findMany({
        where: { userId: colin.id, status: 'dismissed', endDate: null },
      });
      expect(dismissedRows).toHaveLength(1);
    });
  });

  describe('um-dep-06 · a departed actor loses access immediately (AD-17)', () => {
    it('denies Bob before the executor has ever run', async () => {
      const rootId = await makeRootWithPermission('Root-dep06');
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-dep06',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-dep06',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      // Bob has access before the departure is recorded.
      await request(app.getHttpServer())
        .get(`/users/${alice.id}/events`)
        .set('authorization', bearer(bob.id))
        .expect(200);

      await prisma.departure.create({
        data: {
          userId: bob.id,
          effectiveDate: new Date('2000-01-01'),
          reason: 'resignation',
          recordedBy: rootId,
        },
      });

      // SessionAuthGuard checks isDeparted globally (AC-AD-14), before any
      // controller/audience resolution — Bob's token is otherwise valid, so
      // this is a 403 at the guard, not a leak-safe 404 from the route.
      await request(app.getHttpServer())
        .get(`/users/${alice.id}/events`)
        .set('authorization', bearer(bob.id))
        .expect(403);
    });
  });
});
