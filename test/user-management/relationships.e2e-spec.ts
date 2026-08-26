import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/relationships/um-rel-01..08.md
// Preconditions this suite can produce (Alice/Bob/Paula existing, an edge
// already attached) are fulfilled with real requests, not hardcoded ids —
// see .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed.
//
// Declaration order deliberately does NOT follow doc numbering:
// - um-rel-02 revokes the edge um-rel-01 creates, and um-rel-03 needs that
//   same edge still active — so um-rel-03 must run before um-rel-02.
// - um-rel-05 revokes the mentorship edge um-rel-04 creates, and um-rel-06
//   needs that same edge still active to prove a second mentor is allowed
//   alongside it — so um-rel-06 must run before um-rel-05.
// Order here: 01, 03, 02, 04, 06, 05, 07, 08.
//
// api-conventions.md's shape-4 attachment endpoints document only POST and
// DELETE for /users/:id/relationships — no GET/list route is specified yet,
// and no field name is documented for reading current-manager/mentor back
// off GET /users/:id either. Where a scenario's "subsequent read" needs to
// observe edge *absence*, this suite proves it the way DEC-UM-005 already
// relies on: a fresh POST for the same edge type succeeds (201) only when
// no conflicting edge remains.
describe('Relationships — /users/:id/relationships (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let aliceId: string;
  let bobId: string;
  let paulaId: string;

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

    const alice = await createUser({
      firstName: 'Alice',
      workEmail: emailFor('alice'),
    });
    aliceId = alice.id as string;
    const bob = await createUser({
      firstName: 'Bob',
      workEmail: emailFor('bob'),
    });
    bobId = bob.id as string;
    const paula = await createUser({
      firstName: 'Paula',
      workEmail: emailFor('paula'),
    });
    paulaId = paula.id as string;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { workEmail: { contains: runId } },
    });
    await app.close();
  });

  let directRelationshipId: string;

  describe('um-rel-01 · HR Admin assigns reports-to', () => {
    it('creates a direct relationship from Alice to Bob', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'direct', targetId: bobId })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.id).toBeDefined();
      expect(body.type).toBe('direct');
      directRelationshipId = body.id as string;
    });
  });

  describe('um-rel-03 · second reports-to POST without DELETE returns 409', () => {
    it('rejects a second direct edge while one is already active, leaving it unchanged', async () => {
      await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'direct', targetId: paulaId })
        .expect(409);
    });
  });

  describe('um-rel-02 · HR Admin revokes reports-to (hard delete)', () => {
    it('hard-deletes the edge; a fresh direct assignment succeeds afterward', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${aliceId}/relationships/${directRelationshipId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'direct', targetId: paulaId })
        .expect(201);

      // Leave a clean, known state for later blocks: revoke this proof
      // edge immediately so um-rel-08 (concurrency) starts from "no active
      // direct edge", matching its own doc precondition.
      const proofId = (res.body as Record<string, unknown>).id as string;
      await request(app.getHttpServer())
        .delete(`/users/${aliceId}/relationships/${proofId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);
    });
  });

  let mentorshipRelationshipId: string;
  let secondMentorId: string;

  describe('um-rel-04 · HR Admin pairs mentorship and fires mentorship_start', () => {
    it('Test 1 — creates the mentorship edge', async () => {
      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'mentorship', targetId: paulaId })
        .expect(201);

      mentorshipRelationshipId = (res.body as Record<string, unknown>)
        .id as string;
    });

    it('Test 2 — the system event mentorship_start appears on the timeline', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mentorship_start',
            source: 'system',
          }),
        ]),
      );
    });
  });

  describe('um-rel-06 · multiple active mentors allowed', () => {
    it('accepts a second, distinct mentorship edge alongside the first', async () => {
      const anotherMentor = await createUser({
        firstName: 'AnotherMentor',
        workEmail: emailFor('another-mentor'),
      });
      secondMentorId = anotherMentor.id as string;

      const res = await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'mentorship', targetId: secondMentorId })
        .expect(201);

      expect((res.body as Record<string, unknown>).id).toBeDefined();
      // Both edges exist: the first (Paula) 201'd in um-rel-04, and this
      // 201 proves the second is accepted alongside it — the assertion
      // that matters here (no one-mentor uniqueness constraint), rather
      // than a listing read this suite has no documented endpoint for.
    });
  });

  describe('um-rel-05 · HR Admin unpairs mentorship and fires mentorship_end', () => {
    it('Test 1 — revokes the Paula mentorship edge', async () => {
      await request(app.getHttpServer())
        .delete(`/users/${aliceId}/relationships/${mentorshipRelationshipId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);
    });

    it('Test 2 — the system event mentorship_end appears on the timeline', async () => {
      const res = await request(app.getHttpServer())
        .get(`/users/${aliceId}/events`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mentorship_end',
            source: 'system',
          }),
        ]),
      );
    });
  });

  describe('um-rel-07 · non-HR Admin cannot mutate relationships', () => {
    it('Test 1 — reports-to assignment is denied with 403', async () => {
      await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Colin>')
        .send({ type: 'direct', targetId: bobId })
        .expect(403);
    });

    it('Test 2 — mentorship pairing is denied with 403', async () => {
      await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Colin>')
        .send({ type: 'mentorship', targetId: paulaId })
        .expect(403);
    });
  });

  describe('um-rel-08 · concurrent reports-to assign resolves to one edge', () => {
    // @concurrency (DEC-UM-010) — parallel HTTP inside one test, one worker.
    it('accepts exactly one of two concurrent direct assignments', async () => {
      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post(`/users/${aliceId}/relationships`)
          .set('authorization', 'Bearer <token:Root>')
          .send({ type: 'direct', targetId: bobId }),
        request(app.getHttpServer())
          .post(`/users/${aliceId}/relationships`)
          .set('authorization', 'Bearer <token:Root>')
          .send({ type: 'direct', targetId: paulaId }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);

      // Exactly one active edge remains — proven the same way um-rel-02
      // proves absence: a further direct assignment still conflicts.
      await request(app.getHttpServer())
        .post(`/users/${aliceId}/relationships`)
        .set('authorization', 'Bearer <token:Root>')
        .send({ type: 'direct', targetId: secondMentorId })
        .expect(409);
    });
  });
});
