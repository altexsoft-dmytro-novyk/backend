import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import {
  attachPolicyToUser,
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createPPEdge,
  createSeededUser,
  ensurePolicyWithPermission,
  newRunId,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/relationships/um-rel-01..09.md
// (Epic 4, Stories 4.1/4.2/4.3). The prior relationships/ suite (and its
// docs) were mentorship-pair-shaped and dead per the 2026-08-30 audit —
// this file is written from scratch against the real
// POST /users/:id/relationships and POST /departments/:id/manager routes.
//
// "Root" here is a fresh fixture user attached to a run-scoped Policy
// carrying "change organisational relationships" (ensurePolicyWithPermission)
// — not the seeded population's bootstrap Root — same convention
// career-timeline/seed suites use for isolation across parallel runs.
describe('Organisational relationships — Epic 4 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('rel');
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
      `${runId}-change-org-relationships-policy`,
      'change organisational relationships',
    );
    await attachPolicyToUser(prisma, root.id, policy.id);
    return root.id;
  }

  describe('um-rel-01 · manager change success', () => {
    it('replaces the direct edge and journals before/after', async () => {
      const rootId = await makeRootWithPermission('Root-rel01');
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-rel01',
        departmentId,
      );
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-rel01',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel01',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      const res = await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'manager', value: nina.id })
        .expect(201);

      expect(res.body).toEqual({ field: 'manager', value: nina.id });

      const journal = await prisma.relationshipJournal.findFirst({
        where: { subjectUserId: alice.id, fieldType: 'manager' },
        orderBy: { timestamp: 'desc' },
      });
      expect(journal?.beforeValue).toBe(bob.id);
      expect(journal?.afterValue).toBe(nina.id);

      const edge = await prisma.relationship.findUnique({
        where: {
          subjectUserId_type: { subjectUserId: alice.id, type: 'direct' },
        },
      });
      expect(edge?.holderUserId).toBe(nina.id);
    });
  });

  describe('um-rel-02 · manager change self-assignment denied', () => {
    it('rejects the actor naming themselves and leaves the edge unchanged', async () => {
      const rootId = await makeRootWithPermission('Root-rel02');
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-rel02',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel02',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'manager', value: rootId })
        .expect(403);

      const edge = await prisma.relationship.findUnique({
        where: {
          subjectUserId_type: { subjectUserId: alice.id, type: 'direct' },
        },
      });
      expect(edge?.holderUserId).toBe(bob.id);
    });
  });

  describe('um-rel-03 · manager change without permission denied', () => {
    it('denies Bob (no policy attachment) even though he has S11 access to Alice', async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-rel03',
        departmentId,
      );
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-rel03',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel03',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(bob.id))
        .send({ field: 'manager', value: nina.id })
        .expect(403);

      const edge = await prisma.relationship.findUnique({
        where: {
          subjectUserId_type: { subjectUserId: alice.id, type: 'direct' },
        },
      });
      expect(edge?.holderUserId).toBe(bob.id);
    });
  });

  describe('um-rel-04 · people-partner change success', () => {
    it('replaces the people_partner edge', async () => {
      const rootId = await makeRootWithPermission('Root-rel04');
      const paula = await createSeededUser(
        prisma,
        runId,
        'Paula-rel04',
        departmentId,
      );
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-rel04',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel04',
        departmentId,
      );
      await createPPEdge(prisma, alice.id, paula.id);

      const res = await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'people_partner', value: nina.id })
        .expect(201);

      expect(res.body).toEqual({ field: 'people_partner', value: nina.id });

      // Paula's PP access to Alice has ended — her manual-write attempt on
      // Alice's career timeline (AD-26's direct-PP gate) is denied now.
      const followUp = await request(app.getHttpServer())
        .post(`/users/${alice.id}/events`)
        .set('authorization', bearer(paula.id))
        .send({
          type: 'manual_backfill',
          eventDate: '2024-01-01',
          details: {},
        });
      expect([403, 404]).toContain(followUp.status);
    });
  });

  describe('um-rel-05 · people-partner change self-assignment denied', () => {
    it('rejects the actor naming themselves', async () => {
      const rootId = await makeRootWithPermission('Root-rel05');
      const paula = await createSeededUser(
        prisma,
        runId,
        'Paula-rel05',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel05',
        departmentId,
      );
      await createPPEdge(prisma, alice.id, paula.id);

      await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'people_partner', value: rootId })
        .expect(403);

      const edge = await prisma.relationship.findUnique({
        where: {
          subjectUserId_type: {
            subjectUserId: alice.id,
            type: 'people_partner',
          },
        },
      });
      expect(edge?.holderUserId).toBe(paula.id);
    });
  });

  describe('um-rel-06 · department change success', () => {
    it('moves the employee and appends a department_change event', async () => {
      const rootId = await makeRootWithPermission('Root-rel06');
      const deptA = await createDepartment(prisma, runId, {
        name: `${runId}-dept-A`,
      });
      const deptB = await createDepartment(prisma, runId, {
        name: `${runId}-dept-B`,
      });
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel06',
        deptA.id,
      );
      // S9 is colleague:none — give Root Reporting-line read access to
      // Alice so the verification GET below isn't denied for an unrelated
      // reason than what this scenario is actually testing.
      await createDirectEdge(prisma, alice.id, rootId);

      const res = await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'department', value: deptB.id })
        .expect(201);
      expect(res.body).toEqual({ field: 'department', value: deptB.id });

      const events = await request(app.getHttpServer())
        .get(`/users/${alice.id}/events`)
        .set('authorization', bearer(rootId))
        .expect(200);
      const list = (
        events.body as { careertimeline: Array<Record<string, unknown>> }
      ).careertimeline;
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'department_change',
            source: 'system',
            details: { from: deptA.id, to: deptB.id },
          }),
        ]),
      );
    });
  });

  describe('um-rel-07 · department-manager change success', () => {
    it('sets the department manager and journals it', async () => {
      const rootId = await makeRootWithPermission('Root-rel07');
      const deptB = await createDepartment(prisma, runId, {
        name: `${runId}-dept-B2`,
      });
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-rel07',
        deptB.id,
      );

      const res = await request(app.getHttpServer())
        .post(`/departments/${deptB.id}/manager`)
        .set('authorization', bearer(rootId))
        .send({ value: nina.id })
        .expect(201);
      expect(res.body).toEqual({ departmentId: deptB.id, managerId: nina.id });

      const journal = await prisma.relationshipJournal.findFirst({
        where: { subjectUserId: nina.id, fieldType: 'department_manager' },
      });
      expect(journal?.beforeValue).toBeNull();
      expect(journal?.afterValue).toBe(nina.id);

      const dept = await prisma.department.findUnique({
        where: { id: deptB.id },
      });
      expect(dept?.managerId).toBe(nina.id);
    });
  });

  describe('um-rel-08 · department-manager self-assignment denied', () => {
    it('rejects the actor naming themselves', async () => {
      const rootId = await makeRootWithPermission('Root-rel08');
      const deptB = await createDepartment(prisma, runId, {
        name: `${runId}-dept-B3`,
      });

      await request(app.getHttpServer())
        .post(`/departments/${deptB.id}/manager`)
        .set('authorization', bearer(rootId))
        .send({ value: rootId })
        .expect(403);

      const dept = await prisma.department.findUnique({
        where: { id: deptB.id },
      });
      expect(dept?.managerId).toBeNull();
    });
  });

  describe('um-rel-09 · manager change concurrent conflict returns 409', () => {
    it('rejects a stale expectedCurrent after a first write already moved it', async () => {
      const rootId = await makeRootWithPermission('Root-rel09');
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-rel09',
        departmentId,
      );
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-rel09',
        departmentId,
      );
      const tomas = await createSeededUser(
        prisma,
        runId,
        'Tomas-rel09',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-rel09',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);

      await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'manager', value: nina.id, expectedCurrent: bob.id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/users/${alice.id}/relationships`)
        .set('authorization', bearer(rootId))
        .send({ field: 'manager', value: tomas.id, expectedCurrent: bob.id })
        .expect(409);

      const edge = await prisma.relationship.findUnique({
        where: {
          subjectUserId_type: { subjectUserId: alice.id, type: 'direct' },
        },
      });
      expect(edge?.holderUserId).toBe(nina.id);
    });
  });
});
