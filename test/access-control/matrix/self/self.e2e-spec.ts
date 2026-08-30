import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createUser,
  newRunId,
} from '../../fixtures/graph';
import { bearer, signSessionToken } from '../../fixtures/jwt';
import { PrismaService } from '../../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/matrix/self/*.md (38 files).
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
describe('Matrix — Self column, §3.2 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('self');

  let aliceId: string;
  let aliceToken: string;
  let menteeId: string;
  let aliceActionItemId: string;
  let aliceIdpId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId, {
      isHrDepartment: false,
    });
    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
    aliceToken = bearer(signSessionToken(aliceId));
    const mentee = await createUser(prisma, runId, 'Mentee', dept.id);
    menteeId = mentee.id;
    aliceActionItemId = '00000000-0000-7000-8000-000000000101';
    aliceIdpId = '00000000-0000-7000-8000-000000000102';
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-M-S16-EMPLOYEE: S16 field visibility (employee)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('employeeVisibleField');
  });

  it('AC-M-S01-SELF-W-PHOTO: Self uploads own photo', async () => {
    const res = await request(app.getHttpServer())
      .put(`/users/${aliceId}/photo`)
      .set('authorization', aliceToken)
      .send({ contentType: 'image/png' });
    expect([200, 204]).toContain(res.status);
    expect(res.body).toHaveProperty('photoUrl');
  });

  it('AC-M-S1-SE-R: self read s1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('identity');
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('workEmail');
  });

  it('AC-M-S1-SE-W-DEN: self write s1 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S10-SE-R: self read s10', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/leaves`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('leaves');
  });

  it('AC-M-S10-SE-W-DEN: self write s10 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/leaves`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S11-SE-R: self read s11', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projects');
  });

  it('AC-M-S11-SE-W-DEN: self write s11 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/relationships`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S12-SE-R: self read s12', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/assessments`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cds');
    expect(res.body).toHaveProperty('cycle');
  });

  it('AC-M-S12-SE-W-DEN: self write s12 denied (narrower rule)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/assessments`)
      .set('authorization', aliceToken)
      .send({ cycle: '2026-H1' });
    expect(res.status).toBe(403);
  });

  it('AC-M-S12-SE-W-WRITEIDPCOMPLETE: self complete own IDP', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/assessments/${aliceIdpId}`)
      .set('authorization', aliceToken)
      .send({ complete: true });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.complete).toBe(true);
    expect(res.body).toHaveProperty('completedAt');
  });

  it('AC-M-S13-SE-R: self read s13', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mentorship');
    expect(res.body).toHaveProperty('openToMentoring');
  });

  it('AC-M-S13-SE-W-DEN: self write s13 denied (narrower rule)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/mentorship-pairs`)
      .set('authorization', aliceToken)
      .send({ mentorId: aliceId, menteeId: menteeId });
    expect(res.status).toBe(403);
  });

  it('AC-M-S13-SE-W-WRITEMENTORFLAG: self set own mentorship flag', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', aliceToken)
      .send({ openToMentoring: true });
    expect(res.status).toBe(200);
  });

  it('AC-M-S14-SE-R: self read s14', async () => {
    const res = await request(app.getHttpServer())
      .get(`/action-items?assigneeId=${aliceId}`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actionitems');
  });

  it('AC-M-S14-SE-W-WRITECOMPLETE: self mark own action item complete', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/action-items/${aliceActionItemId}`)
      .set('authorization', aliceToken)
      .send({ status: 'completed' });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(res.body).toHaveProperty('completedAt');
  });

  it('AC-M-S14-SE-W-DEN: self write s14 denied (narrower rule)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/action-items`)
      .set('authorization', aliceToken)
      .send({ assigneeId: aliceId, title: 'New task' });
    expect(res.status).toBe(403);
  });

  it('AC-M-S15-SE-R-DEN: self read s15 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/request-history`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S15-SE-W-DEN: self write s15 denied (no access)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/request-history`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S16-SE-R: self read s16', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('customfields');
  });

  it('AC-M-S16-SE-W-DEN: self write s16 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/custom-fields`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S2-SE-R: self read s2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/personal-contacts`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(res.body).toHaveProperty('personalcontacts');
    expect(
      body.personalPhone !== undefined || body.residentialAddress !== undefined,
    ).toBe(true);
  });

  it('AC-M-S2-SE-W: self write s2', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/personal-contacts`)
      .set('authorization', aliceToken)
      .send({ personalPhone: '+10000000001' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S3-SE-R: self read s3', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('emergencycontacts');
  });

  it('AC-M-S3-SE-W: self write s3', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', aliceToken)
      .send({ contactPhone: '+10000000002' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S4-SE-R: self read s4', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('employment');
    expect(res.body).toHaveProperty('grade');
    expect(res.body).toHaveProperty('position');
    expect(res.body).toHaveProperty('employmentStatus');
  });

  it('AC-M-S4-SE-W-DEN: self write s4 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S5-SE-R: self read s5', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/documents`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documents');
  });

  it('AC-M-S5-SE-W-WRITECERTIFICATE: self upload own certificate', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/documents`)
      .set('authorization', aliceToken)
      .send({ type: 'certificate', title: 'AWS Solutions Architect' });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    expect(body.type).toBe('certificate');
  });

  it('AC-M-S5-SE-W-DEN: self write s5 denied (narrower rule)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/documents`)
      .set('authorization', aliceToken)
      .send({ type: 'contract', title: 'Employment contract' });
    expect(res.status).toBe(403);
  });

  it('AC-M-S6-SE-R-DEN: self read s6 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/risks`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S6-SE-W-DEN: self write s6 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/risks`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S7-SE-R: self read s7', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notes');
  });

  it('AC-M-S7-SE-W-DEN: self write s7 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/notes`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S8-SE-R: self read s8', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/feedbacks`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('feedbacks');
  });

  it('AC-M-S8-SE-W-DEN: self write s8 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/feedbacks`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S9-SE-R: self read s9', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/events`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('careertimeline');
  });

  it('AC-M-S9-SE-W-DEN: self write s9 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/events`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(403);
  });
});
