import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  assignToProject,
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createProject,
  createUser,
  newRunId,
} from '../../fixtures/graph';
import { bearer, signSessionToken } from '../../fixtures/jwt';
import { PrismaService } from '../../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/matrix/project-line-gate/*.md
// (4 files: AC-PG-01..04). Phase 1 withholds Project line entirely — these
// prove PM/DM resolve no Project audience and no cross-kind inheritance
// bleeds Reporting line into project membership. Stage 2 of the AD-1 gate,
// committed red.
describe('Matrix — Project-line gate, Phase 1 withhold (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('pg');

  let aliceId: string;
  let peteToken: string;
  let frankToken: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId);

    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
    const pete = await createUser(prisma, runId, 'Pete', dept.id);
    const dave = await createUser(prisma, runId, 'Dave', dept.id);
    const frank = await createUser(prisma, runId, 'Frank', dept.id);

    peteToken = bearer(signSessionToken(pete.id));
    frankToken = bearer(signSessionToken(frank.id));

    const project = await createProject(prisma, runId);
    await assignToProject(prisma, project.id, aliceId);
    await assignToProject(prisma, project.id, pete.id);
    await assignToProject(prisma, project.id, dave.id);

    // Frank reports to Dave (Dave is Frank's manager) — but Frank himself
    // holds no project-management relation to Alice's project, so he must
    // not inherit Dave's project reach through the reports-to edge.
    await createDirectEdge(prisma, frank.id, dave.id);
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-PG-01: PM project gate — S2 denied as Colleague', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/personal-contacts`)
      .set('authorization', peteToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('personalcontacts');
  });

  it('AC-PG-02: PM project gate — S3 denied as Colleague', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', peteToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('emergencycontacts');
  });

  it('AC-PG-03: PM does not receive Project-line S5 subset in Phase 1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/documents`)
      .set('authorization', peteToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('documents');
  });

  it('AC-PG-04: Reports-to manager of DM gets no Project reach', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/risks`)
      .set('authorization', frankToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('risks');
  });
});
