import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createUser,
  newRunId,
} from '../fixtures/graph';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/auth/ac-au-01..03.md (3 files).
// Stage 2 of the AD-1 gate — committed red: no access-control guard exists
// yet, so these currently fail on route-not-found rather than a real 401.
// Representative 401 per endpoint family (AD-1 global 401 rule); auth/
// session correctness itself stays out of scope for user-management's own
// suite (see nest-e2e.md) and is this suite's job instead.
describe('Auth — global 401 rule (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('auth');

  let aliceId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId);
    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-AU-01: Profile read rejects missing token', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', '')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('firstName');
  });

  it('AC-AU-02: Section read rejects missing token', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', '')
      .send({});
    expect(res.status).toBe(401);
  });

  it('AC-AU-03: Section write rejects missing token', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', '')
      .send({ grade: 'L5' });
    expect(res.status).toBe(401);
  });
});
