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

// Scenarios: docs/test-cases/access-control/functional-permission/ac-fp-01..03.md
// (3 files). Stage 2 of the AD-1 gate, committed red.
describe('Functional permission — dual gate, FR-is-not-audience (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('fp');

  let aliceId: string;
  let bobToken: string;
  let idaToken: string;
  let rootToken: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId);

    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;

    // AC-FP-01: Bob has Reporting line RW on Alice's employment (direct
    // edge) but his own FR attachment excludes the employment-edit
    // permission — an attachment exists, it just doesn't include this one.
    const bob = await createUser(prisma, runId, 'Bob', dept.id);
    bobToken = bearer(signSessionToken(bob.id));
    await createDirectEdge(prisma, aliceId, bob.id);
    const limitedPolicy = await createPolicy(prisma, runId, 'limited-manager');
    const someOtherPermission = await ensurePermission(
      prisma,
      'view_org_chart',
    );
    await attachPermissionToPolicy(
      prisma,
      limitedPolicy.id,
      someOtherPermission.id,
    );
    await attachPolicyToUser(prisma, bob.id, limitedPolicy.id);

    // AC-FP-02: Ida holds a custom FR (create_form_campaigns) but no
    // audience over Alice — Colleague-level relation only (no edge).
    const ida = await createUser(prisma, runId, 'Ida', dept.id);
    idaToken = bearer(signSessionToken(ida.id));
    const campaignPolicy = await createPolicy(
      prisma,
      runId,
      'campaign-manager',
    );
    const campaignPermission = await ensurePermission(
      prisma,
      'create_form_campaigns',
    );
    await attachPermissionToPolicy(
      prisma,
      campaignPolicy.id,
      campaignPermission.id,
    );
    await attachPolicyToUser(prisma, ida.id, campaignPolicy.id);

    // AC-FP-03: Root holds HR Admin configuration FR only, unrelated to
    // Alice (§2.2 — HR Admin is not a matrix audience).
    const root = await createUser(prisma, runId, 'Root', dept.id);
    rootToken = bearer(signSessionToken(root.id));
    const hrAdminPolicy = await createPolicy(prisma, runId, 'hr-admin');
    const manageRolesPermission = await ensurePermission(
      prisma,
      'manage_roles',
    );
    await attachPermissionToPolicy(
      prisma,
      hrAdminPolicy.id,
      manageRolesPermission.id,
    );
    await attachPolicyToUser(prisma, root.id, hrAdminPolicy.id);
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-FP-01: Dual gate — matrix write without feature permission', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', bobToken)
      .send({ grade: 'L5' });
    expect(res.status).toBe(403);
  });

  it('AC-FP-02: Feature permission does not grant data access', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', idaToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('employment');
  });

  it('AC-FP-03: HR Admin has no default profile data access', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', rootToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('employment');
  });
});
