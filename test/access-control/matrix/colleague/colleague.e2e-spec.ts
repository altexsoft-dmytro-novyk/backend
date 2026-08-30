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

// Scenarios: docs/test-cases/access-control/matrix/colleague/*.md (34 files).
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
describe('Matrix — Colleague column, §3.2 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('colleague');

  let aliceId: string;
  let colinId: string;
  let colinToken: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId, {
      isHrDepartment: false,
    });
    const alice = await createUser(prisma, runId, 'Alice', dept.id);
    aliceId = alice.id;
    const colin = await createUser(prisma, runId, 'Colin', dept.id);
    colinId = colin.id;
    colinToken = bearer(signSessionToken(colinId));
    // Colin is deliberately unrelated to Alice: no direct/PP edge, no
    // shared project — the Colleague fallback this folder tests.
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  it('AC-M-S16-COLLEAGUE-HIDDEN: S16 field visibility (colleague-hidden)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('managementOnlyField');
    expect(res.body).toHaveProperty('colleagueVisibleField');
  });

  it('AC-M-S16-COLLEAGUE: S16 field visibility (colleague)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('colleagueVisibleField');
  });

  it('AC-M-S1-CO-R: colleague read s1', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('identity');
    expect(res.body).toHaveProperty('firstName');
    expect(res.body).toHaveProperty('lastName');
    expect(res.body).toHaveProperty('workEmail');
  });

  it('AC-M-S1-CO-W-DEN: colleague write s1 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S10-CO-R: colleague read s10', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/leaves`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('leaves');
    expect(res.body).not.toHaveProperty('type');
  });

  it('AC-M-S10-CO-W-DEN: colleague write s10 denied (read-only)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/leaves`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S11-CO-R: colleague read s11', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('projects');
    expect(res.body).not.toHaveProperty('role');
    expect(res.body).not.toHaveProperty('allocation');
    expect(res.body).not.toHaveProperty('startDate');
    expect(res.body).not.toHaveProperty('endDate');
  });

  it('AC-M-S11-CO-W-DEN: colleague write s11 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/relationships`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S12-CO-R-DEN: colleague read s12 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/assessments`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S12-CO-W-DEN: colleague write s12 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/assessments`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S13-CO-R-DEN: colleague read s13 denied', async () => {
    // Corrected 2026-08-30: the original GET /users/:id (aggregate) always
    // 200s since S1 is colleague-readable — S13's dedicated read route is
    // the actual section-specific surface that can 404.
    const res = await request(app.getHttpServer())
      .get(`/mentorship-pairs?userId=${aliceId}`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('pairs');
  });

  it('AC-M-S13-CO-W-DEN: colleague write s13 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/mentorship-pairs`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S14-CO-R-DEN: colleague read s14 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/action-items?assigneeId=${aliceId}`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S14-CO-W-DEN: colleague write s14 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/action-items`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S15-CO-R-DEN: colleague read s15 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/request-history`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S15-CO-W-DEN: colleague write s15 denied (no access)', async () => {
    // Source doc inputURL literally says GET (copy-paste bug shared
    // across all 4 matrix folders' S10/S15 write-denied files) —
    // translated as PATCH, the write verb the scenario text describes.
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/request-history`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S16-CO-R: colleague read s16', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/custom-fields`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('customfields');
    expect(res.body).toHaveProperty('colleagueVisibleField');
    expect(res.body).not.toHaveProperty('managementOnlyField');
  });

  it('AC-M-S16-CO-W-DEN: colleague write s16 denied (read-only)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/custom-fields`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(403);
  });

  it('AC-M-S2-CO-R-DEN: colleague read s2 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/personal-contacts`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S2-CO-W-DEN: colleague write s2 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/personal-contacts`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S3-CO-R-DEN: colleague read s3 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S3-CO-W-DEN: colleague write s3 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/emergency-contacts`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S4-CO-R-DEN: colleague read s4 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/employment`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S4-CO-W-DEN: colleague write s4 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/users/${aliceId}/employment`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S5-CO-R-DEN: colleague read s5 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/documents`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S5-CO-W-DEN: colleague write s5 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/documents`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S6-CO-R-DEN: colleague read s6 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/risks`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S6-CO-W-DEN: colleague write s6 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/risks`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S7-CO-R-DEN: colleague read s7 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/notes`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S7-CO-W-DEN: colleague write s7 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/notes`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S8-CO-R-DEN: colleague read s8 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/feedbacks`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S8-CO-W-DEN: colleague write s8 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/feedbacks`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S9-CO-R-DEN: colleague read s9 denied', async () => {
    const res = await request(app.getHttpServer())
      .get(`/users/${aliceId}/events`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('AC-M-S9-CO-W-DEN: colleague write s9 denied (no access)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/users/${aliceId}/events`)
      .set('authorization', colinToken)
      .send({});
    expect(res.status).toBe(404);
  });
});
