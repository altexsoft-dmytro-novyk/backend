import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/registration/um-reg-01..05.md
// Each block below is a direct, literal translation of one scenario file —
// black-box HTTP calls only. No internal wiring (ports, adapters, fakes) is
// referenced here: how the app resolves "Bearer <token:persona>" into a
// session, and how it checks HR Admin entitlement, are implementation
// decisions for stage 3 — not something this test sets up or assumes.
describe('User registration — POST /users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const runId = `e2e-${Date.now()}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  let bootstrapUserId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirror the global pipe configured in main.ts bootstrap
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    // A self-referencing row so preconditions that need a valid `createdBy`
    // (a real DB constraint, not an implementation-detail assumption) have
    // one to reference — same bootstrap shape as prisma/seed.ts.
    bootstrapUserId = uuidv7();
    await prisma.user.create({
      data: {
        id: bootstrapUserId,
        firstName: 'Bootstrap',
        lastName: 'Fixture',
        position: 'HR Admin',
        country: 'Poland',
        city: 'Warsaw',
        workEmail: emailFor('bootstrap'),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: bootstrapUserId,
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { workEmail: { contains: runId }, id: { not: bootstrapUserId } },
    });
    await prisma.user.deleteMany({ where: { id: bootstrapUserId } });
    await app.close();
  });

  describe('um-reg-01 · HR Admin creates a new hire (success)', () => {
    it('creates the user, activated immediately, with no credential field', async () => {
      const workEmail = emailFor('nina');

      const res = await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          position: 'QA Engineer',
          country: 'Poland',
          city: 'Krakow',
          workEmail,
          companyJoinDate: '2026-09-01',
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.id).toBeDefined();
      expect(body.isActive).toBe(true);
      expect(body.firstName).toBe('Nina');
      expect(body.lastName).toBe('Volkova');
      expect(body.workEmail).toBe(workEmail);
      expect(Object.keys(body)).not.toEqual(
        expect.arrayContaining(['password', 'credential']),
      );
    });
  });

  describe('um-reg-02 · create user without a session (unauthenticated)', () => {
    it('rejects with 401 and creates no row', async () => {
      const workEmail = emailFor('unauth-attempt');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', '')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          workEmail,
        })
        .expect(401);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-03 · create user without the HR Admin permission', () => {
    it('rejects with 403 and creates no row', async () => {
      const workEmail = emailFor('no-permission-attempt');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Colin>')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          workEmail,
        })
        .expect(403);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-04 · duplicate workEmail is rejected', () => {
    it('rejects with 409, creates no second row, leaves the existing one unchanged', async () => {
      const workEmail = emailFor('alice');
      const alice = await prisma.user.create({
        data: {
          firstName: 'Alice',
          lastName: 'Original',
          position: 'Engineer',
          country: 'Poland',
          city: 'Gdansk',
          workEmail,
          companyJoinDate: new Date('2024-01-01'),
          createdBy: bootstrapUserId,
        },
      });

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Alicia',
          lastName: 'Duplicate',
          workEmail,
        })
        .expect(409);

      const matches = await prisma.user.findMany({ where: { workEmail } });
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual(alice);
    });
  });

  describe('um-reg-05 · registration does not establish a session', () => {
    it('creates the user but returns no session/access token', async () => {
      const workEmail = emailFor('no-auto-login');

      const res = await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          workEmail,
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.accessToken).toBeUndefined();
      expect(body.sessionToken).toBeUndefined();
      expect(body.token).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      // Magic-link dispatch itself is not asserted here — there is no
      // internal hook to observe it without pre-supposing an adapter/port
      // design. It becomes observable once a real (or, per
      // nestjs-di-tokens.md, legitimately fake-able external-integration)
      // dispatcher exists to assert against.
    });
  });
});
