import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createPPEdge,
  createUser,
  newRunId,
} from '../../fixtures/graph';
import { bearer, signSessionToken } from '../../fixtures/jwt';
import { PrismaService } from '../../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/matrix/pp/*.md (32 files).
// Stage 2 of the AD-1 gate: translated line-by-line from the approved
// stage-1 scenario docs, committed red — no access-control controller
// exists yet, so every request below is expected to fail today (404/no
// route), for that reason and no other. See ../../fixtures/graph.ts and
// ../../fixtures/jwt.ts for the shared seeding/token machinery every
// access-control E2E file in this suite reuses.
//
// alice-action-item-id / alice-idp-id / mentee-id-backed action items and
// IDP assessment rows have no Prisma model yet (S12 CDS, S14 action items —
// see the architecture spine's Deferred list); those ids are synthetic
// UUIDs with no seam to create them for real, same treatment as the
// magic-link-token placeholder in the user-management suite.
describe('Matrix — PP column, §3.2 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('pp');

  let aliceId: string;
  let paulaId: string;
  let paulaToken: string;
  let menteeId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId, {
      isHrDepartment: false,
    });
    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
    const paula = await createUser(prisma, runId, 'Paula', dept.id);
    paulaId = paula.id;
    paulaToken = bearer(signSessionToken(paulaId));
    await createPPEdge(prisma, aliceId, paulaId);
    const mentee = await createUser(prisma, runId, 'Mentee', dept.id);
    menteeId = mentee.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-M-S1-PP-R: pp read s1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('identity');
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('workEmail');
  });

  it('AC-M-S1-PP-W: pp write s1', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', paulaToken)
      .send({ position: 'Engineer II' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S10-PP-R: pp read s10', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/leaves`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('leaves');
  });

  it('AC-M-S10-PP-W-DEN: pp write s10 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/leaves`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S11-PP-R: pp read s11', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projects');
  });

  it('AC-M-S11-PP-W-DEN: pp write s11 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/relationships`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S12-PP-R: pp read s12', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/assessments`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cds');
    expect(res.body).toHaveProperty('cycle');
  });

  it('AC-M-S12-PP-W: pp write s12', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/assessments`)
      .set('authorization', paulaToken)
      .send({ cycle: '2026-H1' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S13-PP-R: pp read s13', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mentorship');
    expect(res.body).toHaveProperty('openToMentoring');
  });

  it('AC-M-S13-PP-W: pp write s13', async () => {
    const res = await request(app.getHttpServer())
      .post(`/mentorship-pairs`)
      .set('authorization', paulaToken)
      .send({ mentorId: aliceId, menteeId: menteeId });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S14-PP-R: pp read s14', async () => {
    const res = await request(app.getHttpServer())
      .get(`/action-items?assigneeId=${aliceId}`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actionitems');
  });

  it('AC-M-S14-PP-W: pp write s14', async () => {
    const res = await request(app.getHttpServer())
      .post(`/action-items`)
      .set('authorization', paulaToken)
      .send({ assigneeId: aliceId, title: 'Follow up' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S15-PP-R: pp read s15', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/request-history`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('requesthistory');
  });

  it('AC-M-S15-PP-W-DEN: pp write s15 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/request-history`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S16-PP-R: pp read s16', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('customfields');
  });

  it('AC-M-S16-PP-W: pp write s16', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/custom-fields`)
      .set('authorization', paulaToken)
      .send({ managementOnlyField: 'updated' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S2-PP-R: pp read s2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/personal-contacts`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(res.body).toHaveProperty('personalcontacts');
    expect(
      body.personalPhone !== undefined || body.residentialAddress !== undefined,
    ).toBe(true);
  });

  it('AC-M-S2-PP-W: pp write s2', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/personal-contacts`)
      .set('authorization', paulaToken)
      .send({ personalPhone: '+10000000001' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S3-PP-R: pp read s3', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('emergencycontacts');
  });

  it('AC-M-S3-PP-W: pp write s3', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', paulaToken)
      .send({ contactPhone: '+10000000002' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S4-PP-R: pp read s4', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('employment');
    expect(res.body).toHaveProperty('grade');
    expect(res.body).toHaveProperty('position');
    expect(res.body).toHaveProperty('employmentStatus');
  });

  it('AC-M-S4-PP-W: pp write s4', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', paulaToken)
      .send({ grade: 'L4' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S5-PP-R: pp read s5', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/documents`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documents');
  });

  it('AC-M-S5-PP-W: pp write s5', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/documents`)
      .set('authorization', paulaToken)
      .send({ type: 'certificate', title: 'AWS SA' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S6-PP-R: pp read s6', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/risks`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('risks');
    expect(res.body).toHaveProperty('level');
    expect(res.body).toHaveProperty('description');
  });

  it('AC-M-S6-PP-W: pp write s6', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/risks`)
      .set('authorization', paulaToken)
      .send({ level: 'medium', description: 'Delivery slip' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S7-PP-R: pp read s7', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notes');
  });

  it('AC-M-S7-PP-W: pp write s7', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/notes`)
      .set('authorization', paulaToken)
      .send({ body: 'Check-in note', visibleForEmployee: false });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S8-PP-R: pp read s8', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/feedbacks`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('feedbacks');
  });

  it('AC-M-S8-PP-W: pp write s8', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/feedbacks`)
      .set('authorization', paulaToken)
      .send({ body: 'Strong collaborator', sharedWithEmployee: false });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S9-PP-R: pp read s9', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/events`)
      .set('authorization', paulaToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('careertimeline');
  });

  it('AC-M-S9-PP-W: pp write s9', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/events`)
      .set('authorization', paulaToken)
      .send({
        type: 'manual_backfill',
        title: 'Prior role',
        occurredAt: '2019-06-01',
      });
    expect([201, 200]).toContain(res.status);
  });
});
