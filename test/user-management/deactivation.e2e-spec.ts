import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/deactivation/um-deact-01..03.md
// Preconditions this suite can produce (Alice/Colin existing) are fulfilled
// with real POST /users requests, not hardcoded ids — see
// .claude/rules/nest-e2e.md#preconditions-must-be-real-not-assumed.
// um-deact-02 reuses the Colin deactivated by um-deact-01 (the docs' own
// cross-reference), threaded via a closure variable.
describe('Deactivation — DELETE /users/:id (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let colinId: string;

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

  describe('um-deact-01 · HR Admin deactivates a user', () => {
    it('flips isActive to false, and the row survives a direct read', async () => {
      const colin = await createUser({
        firstName: 'Colin',
        workEmail: emailFor('colin-deact-01'),
      });
      colinId = colin.id as string;

      const res = await request(app.getHttpServer())
        .delete(`/users/${colinId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Record<string, unknown>;
      expect(body.isActive).toBe(false);

      const read = await request(app.getHttpServer())
        .get(`/users/${colinId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.isActive).toBe(false);
    });
  });

  describe('um-deact-02 · a deactivated user is excluded from the active-only listing', () => {
    it('omits the deactivated user from GET /users?isActive=true', async () => {
      const res = await request(app.getHttpServer())
        .get('/users')
        .query({ isActive: true })
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      const body = res.body as Array<Record<string, unknown>>;
      expect(body.some((u) => u.id === colinId)).toBe(false);
    });
  });

  describe('um-deact-03 · deactivating a user without the HR Admin permission is denied', () => {
    it('rejects with 403 and leaves isActive unchanged', async () => {
      const alice = await createUser({
        firstName: 'Alice',
        workEmail: emailFor('alice-deact-03'),
      });
      const aliceId = alice.id as string;

      await request(app.getHttpServer())
        .delete(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(403);

      const read = await request(app.getHttpServer())
        .get(`/users/${aliceId}`)
        .set('authorization', 'Bearer <token:Bob>')
        .expect(200);

      const readBody = read.body as Record<string, unknown>;
      expect(readBody.isActive).toBe(true);
    });
  });
});
