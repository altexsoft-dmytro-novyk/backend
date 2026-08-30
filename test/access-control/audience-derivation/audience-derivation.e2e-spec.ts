import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  assignToProject,
  bootstrapApp,
  cleanupRun,
  createDeparture,
  createDepartment,
  createDirectEdge,
  createPPEdge,
  createProject,
  createUser,
  deleteProjectBreakingReferences,
  deleteUserBreakingReferences,
  newRunId,
} from '../fixtures/graph';
import { bearer, signSessionToken } from '../fixtures/jwt';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/access-control/audience-derivation/ac-ad-01..18.md
// (18 files). Stage 2 of the AD-1 gate, committed red.
//
// Each AC-AD-NN scenario gets its own small, isolated cluster of fixture
// users (suffixed by scenario number, e.g. alice02/bob02) rather than one
// shared Alice/Bob/Carol reused across all 18 — several scenarios need
// mutually incompatible graph shapes for what would otherwise be the "same"
// people (AC-AD-03 needs Alice's direct-manager edge intact and working;
// AC-AD-08 needs that exact edge broken). Reusing names across those would
// make one scenario's fixture setup silently corrupt another's.
//
// Judgment call (flagged in the task report): AC-AD-07 says "Frank manages
// Dave by reports-to" (Dave reports to Frank) — the opposite direction
// from matrix/project-line-gate's AC-PG-04 ("Frank reports to Dave"), a
// different file with its own isolated fixture. Followed each file's own
// literal wording rather than forcing one shared direction.
describe('Audience derivation — Self/Reporting/PP/Colleague, Phase 1 gates, AD-20 departure (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('ad');
  let deptId: string;

  beforeAll(async () => {
    const bootstrapped = await bootstrapApp();
    app = bootstrapped.app;
    prisma = bootstrapped.prisma;

    const dept = await createDepartment(prisma, runId);
    deptId = dept.id;
  });

  afterAll(async () => {
    await cleanupRun(prisma, runId);
    await app.close();
  });

  const mkUser = (persona: string) =>
    createUser(prisma, runId, persona, deptId);

  describe('AC-AD-01 · Self wins over Reporting line on own profile', () => {
    let aliceId: string;
    let aliceToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice01');
      const bob = await mkUser('Bob01');
      aliceId = alice.id;
      aliceToken = bearer(signSessionToken(aliceId));
      await createDirectEdge(prisma, aliceId, bob.id);
    });

    it('AC-AD-01: viewing own S6 (— for Self, RW for Reporting) resolves Self, not Reporting', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/risks`)
        .set('authorization', aliceToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('risks');
    });
  });

  describe('AC-AD-02 · Direct Reporting line (unit manager)', () => {
    let aliceId: string;
    let bobToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice02');
      const bob = await mkUser('Bob02');
      aliceId = alice.id;
      bobToken = bearer(signSessionToken(bob.id));
      await createDirectEdge(prisma, aliceId, bob.id);
    });

    it('AC-AD-02: Bob (direct unit manager) reads Alice employment', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('employment');
    });
  });

  describe('AC-AD-03 · Transitive Reporting line', () => {
    let aliceId: string;
    let carolToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice03');
      const bob = await mkUser('Bob03');
      const carol = await mkUser('Carol03');
      aliceId = alice.id;
      carolToken = bearer(signSessionToken(carol.id));
      await createDirectEdge(prisma, aliceId, bob.id);
      await createDirectEdge(prisma, bob.id, carol.id);
    });

    it('AC-AD-03: Carol resolves Reporting line through transitive direct recursion', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', carolToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('employment');
    });
  });

  describe('AC-AD-04 · Directly assigned PP only (Phase 1)', () => {
    let aliceId: string;
    let paulaToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice04');
      const paula = await mkUser('Paula04');
      aliceId = alice.id;
      paulaToken = bearer(signSessionToken(paula.id));
      await createPPEdge(prisma, aliceId, paula.id);
    });

    it('AC-AD-04: Paula (assigned PP) reads Alice personal contacts', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/personal-contacts`)
        .set('authorization', paulaToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('personalcontacts');
    });
  });

  describe('AC-AD-05 · Colleague fallback', () => {
    let aliceId: string;
    let colinToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice05');
      const colin = await mkUser('Colin05');
      aliceId = alice.id;
      colinToken = bearer(signSessionToken(colin.id));
    });

    it('AC-AD-05: Test 1 — whitelist allowed', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', colinToken)
        .send({});
      expect(res.status).toBe(200);
    });

    it('AC-AD-05: Test 2 — non-whitelist denied', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/personal-contacts`)
        .set('authorization', colinToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('personalcontacts');
    });
  });

  describe('AC-AD-06 · Project line withheld in Phase 1', () => {
    let aliceId: string;
    let peteToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice06');
      const pete = await mkUser('Pete06');
      const dave = await mkUser('Dave06');
      aliceId = alice.id;
      peteToken = bearer(signSessionToken(pete.id));
      const project = await createProject(prisma, runId);
      await assignToProject(prisma, project.id, aliceId);
      await assignToProject(prisma, project.id, pete.id);
      await assignToProject(prisma, project.id, dave.id);
    });

    it('AC-AD-06: Pete (PM, shared project, otherwise unrelated) falls back to denied Colleague', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/personal-contacts`)
        .set('authorization', peteToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('personalcontacts');
    });
  });

  describe('AC-AD-07 · No cross-kind inheritance into Project line', () => {
    let aliceId: string;
    let frankToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice07');
      const dave = await mkUser('Dave07');
      const frank = await mkUser('Frank07');
      aliceId = alice.id;
      frankToken = bearer(signSessionToken(frank.id));
      // Frank manages Dave by reports-to (Dave's manager is Frank) — the
      // scenario's own literal wording; Frank holds no project-management
      // relation to Alice's project and is not on it himself.
      await createDirectEdge(prisma, dave.id, frank.id);
      const project = await createProject(prisma, runId);
      await assignToProject(prisma, project.id, aliceId);
      await assignToProject(prisma, project.id, dave.id);
    });

    it('AC-AD-07: Frank does not inherit Project-line reach through Dave', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/risks`)
        .set('authorization', frankToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('risks');
    });
  });

  describe('AC-AD-08 · Broken reports-to edge stops walk', () => {
    let aliceId: string;
    let carolToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice08');
      const brokenManager = await mkUser('BrokenManager08');
      const carol = await mkUser('Carol08');
      aliceId = alice.id;
      carolToken = bearer(signSessionToken(carol.id));
      await createDirectEdge(prisma, aliceId, brokenManager.id);
      await createDirectEdge(prisma, brokenManager.id, carol.id);
      // Deletes brokenManager while both edges above still reference it —
      // see deleteUserBreakingReferences' doc comment for why this needs
      // to bypass ON DELETE RESTRICT deliberately.
      await deleteUserBreakingReferences(
        prisma,
        'relationships',
        brokenManager.id,
      );
    });

    it('AC-AD-08: Carol cannot bridge the orphaned endpoint (fail-closed)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', carolToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });

  describe('AC-AD-09 · Orphan policy grants nothing', () => {
    let aliceId: string;
    let daveToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice09');
      const dave = await mkUser('Dave09');
      aliceId = alice.id;
      daveToken = bearer(signSessionToken(dave.id));
      // Dave's only connection to Alice is a project assignment whose
      // project is then hard-deleted — an orphaned join with zero live
      // members and no other relation to Alice at all (no schema table
      // yet for a project-management "policy" row specifically — the real
      // ProjectAssignment join is the closest structural analogue).
      const project = await createProject(prisma, runId);
      await assignToProject(prisma, project.id, dave.id);
      await deleteProjectBreakingReferences(prisma, project.id);
    });

    it('AC-AD-09: orphan project-assignment join contributes no audience', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', daveToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });

  describe('AC-AD-10 · Department policy withheld in Phase 1', () => {
    let aliceId: string;
    let eveToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice10');
      // No department-management "policy" table exists yet (deferred per
      // the architecture spine) — the closest real substitute is simply
      // no reports-to/PP relation to Alice at all, which is the exact
      // observable behavior this scenario asserts regardless.
      const eve = await mkUser('Eve10');
      aliceId = alice.id;
      eveToken = bearer(signSessionToken(eve.id));
    });

    it('AC-AD-10: department-management relation (unmodeled in Phase 1) grants no audience', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', eveToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });

  describe('AC-AD-11 · PP HR-line withheld in Phase 1', () => {
    let aliceId: string;
    let hanaToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice11');
      const paula = await mkUser('Paula11');
      const hana = await mkUser('Hana11');
      aliceId = alice.id;
      hanaToken = bearer(signSessionToken(hana.id));
      await createPPEdge(prisma, aliceId, paula.id);
      await createDirectEdge(prisma, paula.id, hana.id);
    });

    it('AC-AD-11: Hana does not inherit PP through Paula in Phase 1', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/personal-contacts`)
        .set('authorization', hanaToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('personalcontacts');
    });
  });

  describe('AC-AD-12 · Empty bulk resolution', () => {
    let bobToken: string;

    beforeAll(async () => {
      const bob = await mkUser('Bob12');
      bobToken = bearer(signSessionToken(bob.id));
    });

    it('AC-AD-12: empty ids list resolves immediately with zero graph queries', async () => {
      // Stage 2 asserts response shape here; the "zero resolver queries"
      // half of this scenario needs a query-count hook into the facade,
      // which does not exist until CAP-2's implementation lands.
      const res = await request(app.getHttpServer())
        .get(`/users?ids=`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });
  });

  describe('AC-AD-13 · Multi-audience merge (Reporting + PP)', () => {
    let mergeAliceId: string;
    let morganToken: string;

    beforeAll(async () => {
      const mergeAlice = await mkUser('MergeAlice13');
      const morgan = await mkUser('Morgan13');
      mergeAliceId = mergeAlice.id;
      morganToken = bearer(signSessionToken(morgan.id));
      await createDirectEdge(prisma, mergeAliceId, morgan.id);
      await createPPEdge(prisma, mergeAliceId, morgan.id);
    });

    it('AC-AD-13: Test 1 — merged read (Reporting R sufficient)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${mergeAliceId}/personal-contacts`)
        .set('authorization', morganToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('personalcontacts');
      const body = res.body as Record<string, unknown>;
      expect(
        body.personalPhone !== undefined ||
          body.residentialAddress !== undefined,
      ).toBe(true);
    });

    it('AC-AD-13: Test 2 — merged write (PP RW wins)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/users/${mergeAliceId}/personal-contacts`)
        .set('authorization', morganToken)
        .send({ personalPhone: '+10000000099' });
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.personalPhone).toBe('+10000000099');
    });

    it('AC-AD-13: Test 3 — section where Reporting is RW but PP is R (S6)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${mergeAliceId}/risks`)
        .set('authorization', morganToken)
        .send({ level: 'medium', description: 'Merge proof risk' });
      expect(res.status).toBe(201);
    });
  });

  describe('AC-AD-14 · Due actor denied before resolution', () => {
    let aliceId: string;
    let dueDanToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice14');
      const dueDan = await mkUser('DueDan14');
      aliceId = alice.id;
      dueDanToken = bearer(signSessionToken(dueDan.id));
      await createDeparture(
        prisma,
        dueDan.id,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        dueDan.id,
      );
    });

    it('AC-AD-14: DueDan is denied before feature or audience resolution', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', dueDanToken)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('AC-AD-15 · Due target dismissed projection', () => {
    let aliceDueId: string;
    let bobToken: string;

    beforeAll(async () => {
      const aliceDue = await mkUser('AliceDue15');
      const bob = await mkUser('Bob15');
      aliceDueId = aliceDue.id;
      bobToken = bearer(signSessionToken(bob.id));
      await createDirectEdge(prisma, aliceDueId, bob.id);
      await createDeparture(
        prisma,
        aliceDueId,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        bob.id,
      );
    });

    it('AC-AD-15: Test 1 — dismissed read', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceDueId}`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('firstName');
      expect(res.body).toHaveProperty('lastName');
      expect(res.body).toHaveProperty('workEmail');
      const body = res.body as Record<string, unknown>;
      expect(body.employmentStatus).toBe('dismissed');
      expect(res.body).not.toHaveProperty('personalcontacts');
      expect(res.body).not.toHaveProperty('risks');
    });

    it('AC-AD-15: Test 2 — absent from active list', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users?status=active`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      const items = (res.body as { items?: Array<{ id: string }> }).items ?? [];
      expect(items.some((item) => item.id === aliceDueId)).toBe(false);
    });

    it('AC-AD-15: Test 3 — dismissed-target write denied', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/users/${aliceDueId}/employment`)
        .set('authorization', bobToken)
        .send({ grade: 'L5' });
      expect(res.status).toBe(403);
    });
  });

  describe('AC-AD-16 · Due manager endpoint grants no audience', () => {
    let aliceId: string;
    let carolToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice16');
      const dueBob = await mkUser('DueBob16');
      const carol = await mkUser('Carol16');
      aliceId = alice.id;
      carolToken = bearer(signSessionToken(carol.id));
      await createDirectEdge(prisma, aliceId, dueBob.id);
      await createDirectEdge(prisma, dueBob.id, carol.id);
      await createDeparture(
        prisma,
        dueBob.id,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        carol.id,
      );
    });

    it('AC-AD-16: the due manager endpoint cannot bridge Carol to Alice', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', carolToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });

  describe('AC-AD-17 · Due intermediate node stops recursion', () => {
    let aliceId: string;
    let carolToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice17');
      const dueMid = await mkUser('DueMid17');
      const carol = await mkUser('Carol17');
      aliceId = alice.id;
      carolToken = bearer(signSessionToken(carol.id));
      await createDirectEdge(prisma, aliceId, dueMid.id);
      await createDirectEdge(prisma, dueMid.id, carol.id);
      await createDeparture(
        prisma,
        dueMid.id,
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        carol.id,
      );
    });

    it('AC-AD-17: Carol does not inherit access through the due node DueMid', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', carolToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });

  describe('AC-AD-18 · Project integration unavailable — other audiences continue', () => {
    let aliceId: string;
    let bobToken: string;
    let peteToken: string;

    beforeAll(async () => {
      const alice = await mkUser('Alice18');
      const bob = await mkUser('Bob18');
      const paula = await mkUser('Paula18');
      const pete = await mkUser('Pete18');
      aliceId = alice.id;
      bobToken = bearer(signSessionToken(bob.id));
      peteToken = bearer(signSessionToken(pete.id));
      await createDirectEdge(prisma, aliceId, bob.id);
      await createPPEdge(prisma, aliceId, paula.id);
      const project = await createProject(prisma, runId);
      await assignToProject(prisma, project.id, aliceId);
      await assignToProject(prisma, project.id, pete.id);
    });

    it('AC-AD-18: Test 1 — Reporting continues', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', bobToken)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('employment');
    });

    it('AC-AD-18: Test 2 — Project withheld', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/employment`)
        .set('authorization', peteToken)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('employment');
    });
  });
});
