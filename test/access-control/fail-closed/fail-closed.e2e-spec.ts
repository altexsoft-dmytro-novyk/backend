import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  attachPermissionToPolicy,
  attachPolicyToUser,
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createPolicy,
  createUser,
  ensurePermission,
  newRunId,
} from '../fixtures/graph';
import { bearer, signSessionToken } from '../fixtures/jwt';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/fail-closed/ac-fc-01..03.md
// (3 files). AD-11/AD-12: empty reportsTo, orphaned policy row, bootstrap
// HR Admin is an ordinary revocable FR. Stage 2 of the AD-1 gate,
// committed red.
describe('Fail-closed — AD-11/AD-12 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('fc');

  // AC-FC-01
  let aliceId: string;
  let topLeeToken: string;
  let carolToken: string;

  // AC-FC-02
  let fc02AliceId: string;
  let bobToken: string;

  // AC-FC-03
  let rootId: string;
  let rootToken: string;
  let idaToken: string;
  let hrAdminPolicyId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId);

    // AC-FC-01: Alice -> Bob -> Carol reports-to chain; TopLee sits
    // completely outside it with no reportsTo edge at all (empty
    // reportsToUserId, top of tree) and no PP assignment to Alice.
    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
    const bob = await createUser(prisma, runId, 'Bob', dept.id);
    const carol = await createUser(prisma, runId, 'Carol', dept.id);
    carolToken = bearer(signSessionToken(carol.id));
    await createDirectEdge(prisma, aliceId, bob.id);
    await createDirectEdge(prisma, bob.id, carol.id);
    const topLee = await createUser(prisma, runId, 'TopLee', dept.id);
    topLeeToken = bearer(signSessionToken(topLee.id));

    // AC-FC-02: dedicated Alice/Bob pair (isolated from AC-FC-01's chain, so
    // orphaning the edge here can't affect AC-FC-01's already-run
    // assertions or Carol's transitive access). Bob is Alice's direct
    // manager — a real Phase 1 Reporting-line positive grant — with a
    // seeded certificate on Alice's S5 so the baseline read has real data.
    const fc02Alice = await createUser(prisma, runId, 'Alice2', dept.id);
    fc02AliceId = fc02Alice.id;
    const bob2 = await createUser(prisma, runId, 'Bob2', dept.id);
    bobToken = bearer(signSessionToken(bob2.id));
    await createDirectEdge(prisma, fc02AliceId, bob2.id);
    await prisma.sectionRecord.create({
      data: {
        userId: fc02AliceId,
        section: 's5',
        data: { type: 'certificate', title: 'AWS Certified' },
        createdBy: fc02AliceId,
      },
    });

    // AC-FC-03: Root holds the seeded bootstrap HR Admin FR; Ida holds a
    // second, independent attachment of the same policy so she can revoke
    // Root's without needing Root's own permission.
    const root = await createUser(prisma, runId, 'Root', dept.id);
    rootId = root.id;
    rootToken = bearer(signSessionToken(rootId));
    const ida = await createUser(prisma, runId, 'Ida', dept.id);
    idaToken = bearer(signSessionToken(ida.id));
    const hrAdminPolicy = await createPolicy(prisma, runId, 'hr-admin');
    hrAdminPolicyId = hrAdminPolicy.id;
    const manageRolesPermission = await ensurePermission(
      prisma,
      'manage_roles',
    );
    await attachPermissionToPolicy(
      prisma,
      hrAdminPolicy.id,
      manageRolesPermission.id,
    );
    await attachPolicyToUser(prisma, rootId, hrAdminPolicy.id);
    await attachPolicyToUser(prisma, ida.id, hrAdminPolicy.id);
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  describe('AC-FC-01 · Empty reportsTo grants nothing', () => {
    it('Test 1 — empty reportsTo grants nothing', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', topLeeToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });

    it('Test 2 — descendant walk is normal transitive Reporting line', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', carolToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('employment');
      expect(res.body).toHaveProperty('grade');
      expect(res.body).toHaveProperty('position');
    });
  });

  describe('AC-FC-02 · Orphaned relationship edge after hard-delete', () => {
    it('Test 1 — baseline effective grant (live relationship)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${fc02AliceId}/documents`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('documents');
      const documents = (res.body as { documents: Array<{ type: string }> })
        .documents;
      expect(
        documents.some((d) => d.type === 'cv' || d.type === 'certificate'),
      ).toBe(true);
    });

    it('Test 2 — after orphan', async () => {
      // stateChange: hard-delete Bob's direct Relationship row over Alice —
      // not via the normal DELETE-then-POST reassignment flow, simulating a
      // corrupted/orphaned edge (e.g. a partial migration or manual fix).
      // Relationship rows have no inbound FK references, so a plain delete
      // (no RESTRICT to bypass) is enough.
      await prisma.relationship.deleteMany({
        where: { subjectUserId: fc02AliceId, type: 'direct' },
      });

      const res = await request(app.getHttpServer())
        .get(`/users/${fc02AliceId}/documents`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('documents');
    });
  });

  describe('AC-FC-03 · Bootstrap HR Admin is ordinary revocable FR', () => {
    it('Test 1 — baseline configuration access', async () => {
      const res = await request(app.getHttpServer())
        .get(`/roles`)
        .set('authorization', rootToken)
        .send({});
      expect(res.status).toBe(200);
    });

    it('Test 2 — revoke Root', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/users/${rootId}/policies/${hrAdminPolicyId}`)
        .set('authorization', idaToken)
        .send({});
      expect(res.status).toBe(204);
    });

    it('Test 3 — Root denied', async () => {
      const res = await request(app.getHttpServer())
        .get(`/roles`)
        .set('authorization', rootToken)
        .send({});
      expect(res.status).toBe(403);
    });
  });
});
