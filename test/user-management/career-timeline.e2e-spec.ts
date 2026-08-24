import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/career-timeline/um-ct-01..07.md
// Preconditions this suite can produce (a user existing, a position edited,
// a manual event added) are fulfilled with real requests, not hardcoded ids
// — see .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed.
// um-ct-02 through um-ct-07 build on the same Alice (the docs' own
// cross-references: um-ct-06/07 reuse um-ct-04's event, um-ct-05's steps
// reuse each other's responses), threaded via closure variables.
//
// um-ct-05's "wrong, system-inferred" entry has no HTTP-observable way to
// manufacture — forcing a genuine bad inference isn't a real request any
// client can make. Its baseline entry is seeded through the same manual-add
// endpoint um-ct-03/04 already exercise instead; that substitution doesn't
// change the mechanic under test (soft-delete the wrong entry, append the
// correction).
describe('Career timeline — /users/:id/events (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let aliceId: string;
  let umCt04EventId: string;

  const runId = `e2e-${Date.now()}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (
    overrides: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('authorization', 'Bearer <token:Root>')
      .send({
        firstName: 'Fixture',
        lastName: 'Person',
        position: 'Engineer',
        country: 'Poland',
        city: 'Warsaw',
        companyJoinDate: '2024-01-01',
        ...overrides,
      });
    return res.body as Record<string, unknown>;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { workEmail: { contains: runId } },
    });
    await app.close();
  });

  describe('um-ct-01 · creating a user writes a joined_company event', () => {
    it('lists exactly one system-generated joined_company event for the new hire', async () => {
      const nina = await createUser({
        firstName: 'Nina',
        lastName: 'Volkova',
        workEmail: emailFor('nina-ct-01'),
        companyJoinDate: '2026-09-01',
      });
      const ninaId = nina.id as string;

      const res = await request(app.getHttpServer())
        .get(`/users/${ninaId}/events`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        type: 'joined_company',
        source: 'system',
        eventDate: '2026-09-01',
      });
    });
  });

  describe('um-ct-02 · editing position writes a position_change event', () => {
    it('lists a system-generated position_change event with from/to details', async () => {
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-ct'),
        position: 'Engineer',
      });
      aliceId = alice.id as string;

      await request(app.getHttpServer())
        .patch(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ position: 'Senior Engineer' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body).toEqual(
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

  describe('um-ct-03 · PP manually adds a backfill entry', () => {
    it('creates a manual mentorship_end entry and it appears in the timeline', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Paula>')
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
        .set('authorization', 'Bearer <token:Paula>')
        .expect(200);

      const listBody = list.body as Array<Record<string, unknown>>;
      expect(listBody).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: body.id })]),
      );
    });
  });

  describe('um-ct-04 · Unit Manager manually adds a backfill entry', () => {
    it('creates a manual entry and it appears in the timeline', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({
          type: 'joined_company',
          eventDate: '2019-06-01',
          details: {},
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.source).toBe('manual');
      umCt04EventId = body.id as string;

      const list = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const listBody = list.body as Array<Record<string, unknown>>;
      expect(listBody).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: umCt04EventId }),
        ]),
      );
    });
  });

  describe('um-ct-05 · PP corrects a wrongly-inferred event', () => {
    let wrongEventId: string;
    let correctedEventId: string;

    it('seeds the entry to correct (baseline for Test 1)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Paula>')
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
        .set('authorization', 'Bearer <token:Paula>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body.some((e) => e.id === wrongEventId)).toBe(true);
    });

    it('Test 2 — soft-deletes the wrong entry', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${aliceId}/events/${wrongEventId}`)
        .set('authorization', 'Bearer <token:Paula>')
        .expect(200);
    });

    it('Test 3 — appends the corrected entry', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Paula>')
        .send({
          type: 'position_change',
          eventDate: '2026-08-01',
          details: { from: 'Engineer', to: 'Senior Engineer' },
          source: 'manual',
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      correctedEventId = body.id as string;
      expect(correctedEventId).toBeDefined();
      expect(correctedEventId).not.toBe(wrongEventId);
    });

    it('Test 4 — the corrected timeline excludes the wrong entry and includes the correction', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Paula>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body.some((e) => e.id === wrongEventId)).toBe(false);
      expect(body.some((e) => e.id === correctedEventId)).toBe(true);
    });
  });

  describe('um-ct-06 · Unit Manager soft-deletes an event', () => {
    it('soft-deletes the manually-added event from um-ct-04', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${aliceId}/events/${umCt04EventId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);
    });
  });

  describe('um-ct-07 · a soft-deleted event is absent, not null, from the timeline read', () => {
    it('excludes the deleted event entirely from a subsequent read', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body.some((e) => e.id === umCt04EventId)).toBe(false);
    });
  });
});
