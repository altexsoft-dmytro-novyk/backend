import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/profile/um-pf-01..04.md
// Preconditions this suite can produce (Alice/Colin existing with specific
// field values) are fulfilled with real POST /users requests, not hardcoded
// ids — see .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed.
// `Bearer <token:Persona>` stays a literal placeholder: session/authz is
// access-control's suite's job, not this one's (see the user-management
// test-case README).
describe('Profile edits — PATCH /users/:id, PUT /users/:id/photo (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

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

  describe('um-pf-01 · Manager-line edit to identity fields persists', () => {
    it('writes the new position/city, then a read reflects them', async () => {
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-pf-01'),
        position: 'Engineer',
        city: 'Warsaw',
      });
      const aliceId = alice.id as string;

      const res = await request(app.getHttpServer())
        .patch(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ position: 'Senior Engineer', city: 'Krakow' })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.position).toBe('Senior Engineer');
      expect(body.city).toBe('Krakow');

      const read = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.position).toBe('Senior Engineer');
      expect(readBody.city).toBe('Krakow');
    });
  });

  describe('um-pf-02 · Self photo upload persists', () => {
    it('writes a new photo reference, then a read reflects it', async () => {
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-pf-02'),
      });
      const aliceId = alice.id as string;

      const res = await request(app.getHttpServer())
        .put(`/users/${aliceId}/photo`)
        .set('authorization', 'Bearer <token:Alice>')
        .attach('photo', Buffer.from('fake-jpeg-bytes'), 'alice.jpg')
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.photo).toBeDefined();
      expect(body.photo).not.toBeNull();

      const read = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Alice>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.photo).toBe(body.photo);
    });
  });

  describe('um-pf-03 · editing workEmail to an address already in use is rejected', () => {
    it('rejects with 409 and leaves workEmail unchanged', async () => {
      const colinEmail = emailFor('colin-pf-03');
      await createUser({ firstName: 'Colin', workEmail: colinEmail });
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-pf-03'),
      });
      const aliceId = alice.id as string;

      await request(app.getHttpServer())
        .patch(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ workEmail: colinEmail })
        .expect(409);

      const read = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.workEmail).not.toBe(colinEmail);
    });
  });

  describe('um-pf-04 · setting ttId to a value already in use is rejected', () => {
    it('rejects with 409 and leaves ttId unchanged (null)', async () => {
      const ttId = `tt-${runId}`;
      await createUser({
        firstName: 'Colin',
        workEmail: emailFor('colin-pf-04'),
        ttId,
      });
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-pf-04'),
      });
      const aliceId = alice.id as string;

      await request(app.getHttpServer())
        .patch(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .send({ ttId })
        .expect(409);

      const read = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.ttId).toBeNull();
    });
  });
});
