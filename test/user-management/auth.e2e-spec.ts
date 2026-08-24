import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/auth/um-auth-01..05.md
// Preconditions this suite can produce (an existing `User`) are fulfilled
// with a real POST /users request, not a hardcoded id — see
// .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed. The
// magic-link token itself has no HTTP-observable seam (delivered by email),
// so it stays a literal placeholder per the docs' own convention, same as
// registration.e2e-spec.ts's um-reg-05 note.
describe('Magic-link auth — POST /auth/magic-link(/consume) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const runId = `e2e-${Date.now()}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (
    workEmail: string,
  ): Promise<Record<string, unknown>> => {
    const res = await request(app.getHttpServer())
      .post('/users')
      .set('authorization', 'Bearer <token:Root>')
      .send({
        firstName: 'Alice',
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'Poland',
        city: 'Warsaw',
        workEmail,
        companyJoinDate: '2024-01-01',
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

  describe('um-auth-01 · request a magic link for a registered email', () => {
    it('accepts the request and confirms dispatch with no sensitive data', async () => {
      const workEmail = emailFor('alice-01');
      await createUser(workEmail);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: workEmail })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
      expect(Object.keys(body)).not.toEqual(
        expect.arrayContaining(['token', 'password']),
      );
    });
  });

  describe('um-auth-02 · request a magic link for an unregistered email', () => {
    it('responds identically to um-auth-01, revealing nothing about account existence', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/magic-link')
        .set('authorization', '')
        .send({ email: emailFor('nobody') })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.sent).toBe(true);
    });
  });

  describe('um-auth-03 · consuming a valid magic-link token establishes a session', () => {
    it('returns a session token usable for a follow-up authenticated request', async () => {
      const alice = await createUser(emailFor('alice-03'));
      const aliceId = alice.id as string;

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: '<magic-link-token:alice>' })
        .expect(200);

      const body = res.body as Record<string, unknown>;
      const sessionToken = body.accessToken ?? body.sessionToken ?? body.token;
      expect(sessionToken).toBeDefined();

      await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', `Bearer ${String(sessionToken)}`)
        .expect(200);
    });
  });

  describe('um-auth-04 · consuming an expired magic-link token is denied', () => {
    it('rejects with 401 and no session token', async () => {
      await createUser(emailFor('alice-04'));

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: '<expired-magic-link-token:alice>' })
        .expect(401);

      const body = res.body as Record<string, unknown>;
      expect(
        body.accessToken ?? body.sessionToken ?? body.token,
      ).toBeUndefined();
    });
  });

  describe('um-auth-05 · a magic-link token cannot be consumed twice', () => {
    it('accepts the first consumption and denies the replay', async () => {
      await createUser(emailFor('alice-05'));

      await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: '<magic-link-token:alice>' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/auth/magic-link/consume')
        .set('authorization', '')
        .send({ token: '<magic-link-token:alice>' })
        .expect(401);

      const body = res.body as Record<string, unknown>;
      expect(
        body.accessToken ?? body.sessionToken ?? body.token,
      ).toBeUndefined();
    });
  });
});
