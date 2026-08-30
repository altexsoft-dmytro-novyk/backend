import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signSessionToken } from '../../../src/access-control/application/guards/session-token';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { bootstrapApp } from '../fixtures/app';
import {
  cleanupRun,
  createDepartment,
  createDirectEdge,
  createPPEdge,
  createSeededUser,
  newRunId,
  writeJoinedCompanyEvent,
} from '../fixtures/seed-data';

// Scenarios: docs/test-cases/user-management/career-timeline/um-ct-01,02,03,
// 05,06,07.md (um-ct-04/08 are dead/uncited per the 2026-08-30 audit — see
// docs/test-cases/user-management/README.md's Layout table — not
// translated here; um-ct-06's own doc still cites "the event from um-ct-04"
// as its precondition, so this file produces that precondition itself, in
// its own um-ct-06 block, via the same real manual-add endpoint um-ct-04
// would have used).
//
// Rewritten from scratch (2026-08-30 architecture-reset audit) — same
// reasons as ../profile/profile.e2e-spec.ts's top-of-file note: POST
// /users is retired (AD-25) and literal `Bearer <token:Persona>`
// placeholders no longer clear the real SessionAuthGuard. Users/
// relationships are seeded directly via Prisma; sessions are real,
// production-signed tokens (signSessionToken).
//
// um-ct-01's trigger ("creating a user writes a joined_company event") has
// no HTTP-observable create path any more (AD-25: seed/import only) — this
// suite substitutes the same closest-real primitive the seed suite already
// established (createSeededUser + writeJoinedCompanyEvent, both direct
// Prisma writes standing in for the real import script's row-level output)
// and then asserts the outcome through the real GET /users/:id/events read.
//
// um-ct-05's "wrong, system-inferred" entry has no HTTP-observable way to
// manufacture (forcing a genuine bad inference isn't a real request any
// client can make) — its baseline is seeded through the same manual-add
// endpoint um-ct-03 exercises instead, per nest-e2e.md's "closest real
// substitute" guidance; the correction mechanic under test (soft-delete +
// append) is unaffected by how the wrong entry got there.
describe('Career timeline — /users/:id/events (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const runId = newRunId('ct');
  let departmentId: string;

  const bearer = (userId: string) => `Bearer ${signSessionToken(userId)}`;
  const careertimeline = (body: unknown): Array<Record<string, unknown>> =>
    (body as { careertimeline: Array<Record<string, unknown>> }).careertimeline;

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

  describe('um-ct-01 · seeding a user writes a joined_company event', () => {
    it('lists exactly one system-generated joined_company event for the new hire', async () => {
      const companyJoinDate = new Date('2026-09-01');
      const nina = await createSeededUser(
        prisma,
        runId,
        'Nina-ct01',
        departmentId,
        { companyJoinDate },
      );
      await writeJoinedCompanyEvent(prisma, nina.id, companyJoinDate, nina.id);

      const res = await request(app.getHttpServer())
        .get(`/users/${nina.id}/events`)
        .set('authorization', bearer(nina.id))
        .expect(200);

      const events = careertimeline(res.body);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('joined_company');
      expect(events[0].source).toBe('system');
      expect(
        new Date(events[0].eventDate as string).toISOString().slice(0, 10),
      ).toBe('2026-09-01');
    });
  });

  describe('um-ct-02 · editing position writes a position_change event', () => {
    let aliceId: string;
    let bobId: string;

    it('lists a system-generated position_change event with from/to details', async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-ct02',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-ct02',
        departmentId,
        { position: 'Engineer' },
      );
      await createDirectEdge(prisma, alice.id, bob.id);
      aliceId = alice.id;
      bobId = bob.id;

      await request(app.getHttpServer())
        .patch(`/users/${aliceId}`)
        .set('authorization', bearer(bobId))
        .send({ position: 'Senior Engineer' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', bearer(bobId))
        .expect(200);

      const events = careertimeline(res.body);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'position_change',
            source: 'system',
            details: { from: 'Engineer', to: 'Senior Engineer' },
          }),
        ]),
      );
    });
  });

  describe('um-ct-03/05/06/07 · manual add, correction, and delete', () => {
    let aliceId: string;
    let bobId: string;
    let paulaId: string;

    beforeAll(async () => {
      const bob = await createSeededUser(
        prisma,
        runId,
        'Bob-ct036',
        departmentId,
      );
      const paula = await createSeededUser(
        prisma,
        runId,
        'Paula-ct036',
        departmentId,
      );
      const alice = await createSeededUser(
        prisma,
        runId,
        'Alice-ct036',
        departmentId,
      );
      await createDirectEdge(prisma, alice.id, bob.id);
      await createPPEdge(prisma, alice.id, paula.id);
      aliceId = alice.id;
      bobId = bob.id;
      paulaId = paula.id;
    });

    it('um-ct-03 · PP manually adds a backfill entry', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/events`)
        .set('authorization', bearer(paulaId))
        .send({
          type: 'mentorship_end',
          eventDate: '2024-03-15',
          details: {},
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.source).toBe('manual');
      expect(body.type).toBe('mentorship_end');

      const list = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', bearer(paulaId))
        .expect(200);

      expect(careertimeline(list.body)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: body.id })]),
      );
    });

    describe('um-ct-05 · PP corrects a wrongly-inferred event', () => {
      let wrongEventId: string;
      let correctedEventId: string;

      it('seeds the entry to correct (baseline for Test 1)', async () => {
        const res = await request(app.getHttpServer())
          .post(`/users/${aliceId}/events`)
          .set('authorization', bearer(paulaId))
          .send({
            type: 'position_change',
            eventDate: '2026-08-01',
            details: { from: 'Engineer', to: 'Sr. Enginer' },
          })
          .expect(201);

        wrongEventId = (res.body as Record<string, unknown>).id as string;
      });

      it('Test 1 — baseline: the wrong entry exists', async () => {
        const res = await request(app.getHttpServer())
          .get(`/users/${aliceId}/events`)
          .set('authorization', bearer(paulaId))
          .expect(200);

        expect(
          careertimeline(res.body).some((e) => e.id === wrongEventId),
        ).toBe(true);
      });

      it('Test 2 — soft-deletes the wrong entry', async () => {
        await request(app.getHttpServer())
          .delete(`/users/${aliceId}/events/${wrongEventId}`)
          .set('authorization', bearer(paulaId))
          .expect(200);
      });

      it('Test 3 — appends the corrected entry', async () => {
        const res = await request(app.getHttpServer())
          .post(`/users/${aliceId}/events`)
          .set('authorization', bearer(paulaId))
          .send({
            type: 'position_change',
            eventDate: '2026-08-01',
            details: { from: 'Engineer', to: 'Senior Engineer' },
          })
          .expect(201);

        correctedEventId = (res.body as Record<string, unknown>).id as string;
        expect(correctedEventId).toBeDefined();
        expect(correctedEventId).not.toBe(wrongEventId);
      });

      it('Test 4 — the corrected timeline excludes the wrong entry and includes the correction', async () => {
        const res = await request(app.getHttpServer())
          .get(`/users/${aliceId}/events`)
          .set('authorization', bearer(paulaId))
          .expect(200);

        const events = careertimeline(res.body);
        expect(events.some((e) => e.id === wrongEventId)).toBe(false);
        expect(events.some((e) => e.id === correctedEventId)).toBe(true);
      });
    });

    describe('um-ct-06/07 · Unit Manager soft-deletes an event, then it is absent from reads', () => {
      let manualEventId: string;

      it('sets up the manual entry the doc calls "the event from um-ct-04"', async () => {
        const res = await request(app.getHttpServer())
          .post(`/users/${aliceId}/events`)
          .set('authorization', bearer(bobId))
          .send({
            type: 'joined_company',
            eventDate: '2019-06-01',
            details: {},
          })
          .expect(201);
        manualEventId = (res.body as Record<string, unknown>).id as string;
      });

      it('um-ct-06 · Bob soft-deletes it', async () => {
        await request(app.getHttpServer())
          .delete(`/users/${aliceId}/events/${manualEventId}`)
          .set('authorization', bearer(bobId))
          .expect(200);
      });

      it('um-ct-07 · a soft-deleted event is absent, not null, from the timeline read', async () => {
        const res = await request(app.getHttpServer())
          .get(`/users/${aliceId}/events`)
          .set('authorization', bearer(bobId))
          .expect(200);

        expect(
          careertimeline(res.body).some((e) => e.id === manualEventId),
        ).toBe(false);
      });
    });
  });
});
