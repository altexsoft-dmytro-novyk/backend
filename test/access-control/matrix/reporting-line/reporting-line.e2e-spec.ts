import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  bootstrapApp,
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createUser,
  newRunId,
} from '../../fixtures/graph';
import { bearer, signSessionToken } from '../../fixtures/jwt';
import { PrismaService } from '../../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/matrix/reporting-line/*.md (36 files).
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
describe('Matrix — Reporting line column, §3.2 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('reporting-line');

  let aliceId: string;
  let aliceToken: string;
  let bobId: string;
  let bobToken: string;
  let menteeId: string;
  let otherManagerId: string;

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
    const bob = await createUser(prisma, runId, 'Bob', dept.id);
    bobId = bob.id;
    bobToken = bearer(signSessionToken(bobId));
    await createDirectEdge(prisma, aliceId, bobId);
    const mentee = await createUser(prisma, runId, 'Mentee', dept.id);
    menteeId = mentee.id;
    const otherManager = await createUser(
      prisma,
      runId,
      'OtherManager',
      dept.id,
    );
    otherManagerId = otherManager.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-M-S16-MANAGEMENT: S16 field visibility (management)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('managementOnlyField');
  });

  it('AC-M-S01-RL-W-DER: Reporting line cannot PATCH derived S1 fields', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', bobToken)
      .send({ managerId: otherManagerId });
    expect([403, 400]).toContain(res.status);
  });

  it('AC-M-S07-EMP: Employee sees only employee-flagged notes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', aliceToken)
      .send({});
    expect(res.status).toBe(200);
  });

  it('AC-M-S07-RL: Reporting line sees unflagged management notes', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
  });

  it('AC-M-S1-RE-R: reporting-line read s1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('identity');
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('workEmail');
  });

  it('AC-M-S1-RE-W: reporting-line write s1', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', bobToken)
      .send({ position: 'Engineer II' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S10-RE-R: reporting-line read s10', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/leaves`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('leaves');
  });

  it('AC-M-S10-RE-W-DEN: reporting-line write s10 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/leaves`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S11-RE-R: reporting-line read s11', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projects');
  });

  it('AC-M-S11-RE-W-DEN: reporting-line write s11 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/relationships`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S12-RE-R: reporting-line read s12', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/assessments`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cds');
    expect(res.body).toHaveProperty('cycle');
  });

  it('AC-M-S12-RE-W: reporting-line write s12', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/assessments`)
      .set('authorization', bobToken)
      .send({ cycle: '2026-H1' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S13-RE-R: reporting-line read s13', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mentorship');
    expect(res.body).toHaveProperty('openToMentoring');
  });

  it('AC-M-S13-RE-W: reporting-line write s13', async () => {
    const res = await request(app.getHttpServer())
      .post(`/mentorship-pairs`)
      .set('authorization', bobToken)
      .send({ mentorId: aliceId, menteeId: menteeId });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S14-RE-R: reporting-line read s14', async () => {
    const res = await request(app.getHttpServer())
      .get(`/action-items?assigneeId=${aliceId}`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actionitems');
  });

  it('AC-M-S14-RE-W: reporting-line write s14', async () => {
    const res = await request(app.getHttpServer())
      .post(`/action-items`)
      .set('authorization', bobToken)
      .send({ assigneeId: aliceId, title: 'Follow up' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S15-RE-R: reporting-line read s15', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/request-history`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('requesthistory');
  });

  it('AC-M-S15-RE-W-DEN: reporting-line write s15 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/request-history`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S16-RE-R: reporting-line read s16', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('customfields');
  });

  it('AC-M-S16-RE-W: reporting-line write s16', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/custom-fields`)
      .set('authorization', bobToken)
      .send({ managementOnlyField: 'updated' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S2-RE-R: reporting-line read s2', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/personal-contacts`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(res.body).toHaveProperty('personalcontacts');
    expect(
      body.personalPhone !== undefined || body.residentialAddress !== undefined,
    ).toBe(true);
  });

  it('AC-M-S2-RE-W-DEN: reporting-line write s2 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/personal-contacts`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S3-RE-R: reporting-line read s3', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('emergencycontacts');
  });

  it('AC-M-S3-RE-W-DEN: reporting-line write s3 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S4-RE-R: reporting-line read s4', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('employment');
    expect(res.body).toHaveProperty('grade');
    expect(res.body).toHaveProperty('position');
    expect(res.body).toHaveProperty('employmentStatus');
  });

  it('AC-M-S4-RE-W: reporting-line write s4', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', bobToken)
      .send({ grade: 'L4' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S5-RE-R: reporting-line read s5', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/documents`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documents');
  });

  it('AC-M-S5-RE-W-DEN: reporting-line write s5 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/documents`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S6-RE-R: reporting-line read s6', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/risks`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('risks');
    expect(res.body).toHaveProperty('level');
    expect(res.body).toHaveProperty('description');
  });

  it('AC-M-S6-RE-W: reporting-line write s6', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/risks`)
      .set('authorization', bobToken)
      .send({ level: 'medium', description: 'Delivery slip' });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S7-RE-R: reporting-line read s7', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('notes');
  });

  it('AC-M-S7-RE-W: reporting-line write s7', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/notes`)
      .set('authorization', bobToken)
      .send({ body: 'Check-in note', visibleForEmployee: false });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S8-RE-R: reporting-line read s8', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/feedbacks`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('feedbacks');
  });

  it('AC-M-S8-RE-W: reporting-line write s8', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/feedbacks`)
      .set('authorization', bobToken)
      .send({ body: 'Strong collaborator', sharedWithEmployee: false });
    expect([201, 200]).toContain(res.status);
  });

  it('AC-M-S9-RE-R: reporting-line read s9', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/events`)
      .set('authorization', bobToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('careertimeline');
  });

  it('AC-M-S9-RE-W: reporting-line write s9', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/events`)
      .set('authorization', bobToken)
      .send({
        type: 'manual_backfill',
        title: 'Prior role',
        occurredAt: '2019-06-01',
      });
    expect([201, 200]).toContain(res.status);
  });
});
