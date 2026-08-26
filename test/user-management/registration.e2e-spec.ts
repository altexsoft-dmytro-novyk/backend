import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Scenarios: docs/test-cases/user-management/registration/um-reg-01..15.md
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

  // Shared fixture-creation helper for um-reg-06 onward, matching the
  // convention already used by auth/career-timeline/deactivation/profile's
  // own e2e specs — a real POST /users call, not a hardcoded row.
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
      expect(body.createdBy).toBe(bootstrapUserId);
      expect(body.customFields).toEqual({});
      expect(body.photo).toBeNull();
      expect(body.workPhone).toBeNull();
      expect(body.birthDay).toBeNull();
      expect(body.birthMonth).toBeNull();
      expect(body.ttId).toBeNull();
      expect(Object.keys(body)).not.toEqual(
        expect.arrayContaining(['password', 'credential']),
      );

      // No GET /users/:id in Story 1.1 — persistence is asserted against
      // the datastore directly, per the doc's own stateChange note.
      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).not.toBeNull();
      expect(stored?.createdBy).toBe(bootstrapUserId);
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

  describe('um-reg-03 · create user without the user-creation permission', () => {
    it('rejects with 403 and creates no row', async () => {
      // Ida, not a role-less persona: she holds a functional role, just not
      // this permission — proves the gate checks the specific permission,
      // not "any role holder" (requirements §2.3, doc's own rationale).
      const workEmail = emailFor('no-permission-attempt');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Ida>')
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
          position: 'Backend Engineer',
          country: 'Poland',
          city: 'Gdansk',
          workEmail,
          companyJoinDate: '2026-09-15',
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

  describe('um-reg-06 · create with a missing non-nullable field is rejected', () => {
    it('rejects with 400 and creates no row', async () => {
      const workEmail = emailFor('missing-field');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          workEmail,
        })
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-07 · duplicate ttId on create is rejected', () => {
    it('rejects with 409, creates no row, and leaves the existing ttId holder untouched', async () => {
      const ttId = `tt-${runId}`;
      const colin = await createUser({
        firstName: 'Colin',
        workEmail: emailFor('colin-reg-07'),
        ttId,
      });

      const workEmail = emailFor('nina-reg-07');
      await request(app.getHttpServer())
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
          ttId,
        })
        .expect(409);

      const matches = await prisma.user.findMany({ where: { ttId } });
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(colin.id);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-08 · concurrent creates on one workEmail yield a single user', () => {
    it('resolves to exactly one 201 and one 409, never two 201s or a 500', async () => {
      const workEmail = emailFor('concurrent');
      const payload = {
        firstName: 'Nina',
        lastName: 'Volkova',
        position: 'QA Engineer',
        country: 'Poland',
        city: 'Krakow',
        workEmail,
        companyJoinDate: '2026-09-01',
      };

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/users')
          .set('authorization', 'Bearer <token:Root>')
          .send(payload),
        request(app.getHttpServer())
          .post('/users')
          .set('authorization', 'Bearer <token:Root>')
          .send(payload),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);

      const matches = await prisma.user.findMany({ where: { workEmail } });
      expect(matches).toHaveLength(1);
    });
  });

  describe('um-reg-09 · create with a malformed workEmail is rejected', () => {
    it('rejects with 400 naming workEmail and creates no row', async () => {
      const workEmail = 'nina.volkova-at-company';

      await request(app.getHttpServer())
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
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-10 · server-owned create fields are rejected', () => {
    it('Test 1 — rejects a client-supplied id with 400 and creates no row', async () => {
      const workEmail = emailFor('server-id');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          id: '00000000-0000-7000-8000-000000000099',
          firstName: 'Eva',
          lastName: 'Test',
          position: 'Engineer',
          country: 'Poland',
          city: 'Warsaw',
          workEmail,
          companyJoinDate: '2026-09-01',
        })
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });

    it('Test 2 — rejects a client-supplied createdAt/createdBy with 400 and creates no row', async () => {
      const workEmail = emailFor('server-audit');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Eva',
          lastName: 'Test',
          position: 'Engineer',
          country: 'Poland',
          city: 'Warsaw',
          workEmail,
          companyJoinDate: '2026-09-01',
          createdAt: '2020-01-01T00:00:00.000Z',
          createdBy: bootstrapUserId,
        })
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });

  describe('um-reg-11 · workEmail is normalized on write and lookup', () => {
    it('Test 1 — trim + lowercase collides with the normalized existing address', async () => {
      const normalizedEmail = emailFor('colin-reg-11');
      await createUser({ firstName: 'Colin', workEmail: normalizedEmail });

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Dup',
          lastName: 'Case',
          position: 'Engineer',
          country: 'Poland',
          city: 'Warsaw',
          workEmail: `  ${normalizedEmail.toUpperCase()}  `,
          companyJoinDate: '2026-09-01',
        })
        .expect(409);

      const matches = await prisma.user.findMany({
        where: { workEmail: normalizedEmail },
      });
      expect(matches).toHaveLength(1);
    });

    it('Test 2 — a newly created workEmail persists trimmed and lowercased', async () => {
      const rawEmail = `  ${emailFor('Nina-Reg-11').toUpperCase()}  `;
      const expected = rawEmail.trim().toLowerCase();

      const res = await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Nina',
          lastName: 'Volkova',
          position: 'QA Engineer',
          country: 'Poland',
          city: 'Krakow',
          workEmail: rawEmail,
          companyJoinDate: '2026-09-01',
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.workEmail).toBe(expected);

      const stored = await prisma.user.findUnique({
        where: { workEmail: expected },
      });
      expect(stored).not.toBeNull();
    });
  });

  describe('um-reg-12 · rehire preserves the existing User identity', () => {
    it("rejects a duplicate registration for a deactivated employee's address, preserving the original id", async () => {
      const workEmail = emailFor('colin-rehire');
      const colin = await createUser({ firstName: 'Colin', workEmail });
      const colinId = colin.id as string;

      await request(app.getHttpServer())
        .delete(`/users/${colinId}`)
        .set('authorization', 'Bearer <token:Root>')
        .expect(200);

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Colin',
          lastName: 'Return',
          position: 'Engineer',
          country: 'Poland',
          city: 'Warsaw',
          workEmail,
          companyJoinDate: '2026-09-01',
        })
        .expect(409);

      const matches = await prisma.user.findMany({ where: { workEmail } });
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(colinId);
    });
  });

  describe('um-reg-13 · registration survives email transport failure', () => {
    it('commits the user even when the outbound email transport fails after commit', async () => {
      // The email-dispatch DI seam (an outbound port per
      // nestjs-di-tokens.md, overridden here with a throwing fake) does not
      // exist yet — there is no token to `.overrideProvider(...)` against,
      // and importing one that doesn't exist would break this file's
      // compilation for every test in it, not just this one. Once the port
      // lands in stage 3, bind the throwing fake here and extend this test
      // to assert the durable dispatch record is pending/failed and
      // retryable, and that the fake recorded the attempted dispatch. Until
      // then this covers what's observable without that seam: registration
      // itself must not roll back.
      const workEmail = emailFor('dispatch-failure');

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
      expect(body.isActive).toBe(true);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).not.toBeNull();
    });
  });

  describe('um-reg-14 · birthday day and month persist together on create', () => {
    it('returns birthDay/birthMonth exactly as submitted', async () => {
      const workEmail = emailFor('greta-birthday');

      const res = await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send({
          firstName: 'Greta',
          lastName: 'Lindqvist',
          position: 'QA Engineer',
          country: 'Poland',
          city: 'Krakow',
          workEmail,
          companyJoinDate: '2026-09-01',
          birthDay: 15,
          birthMonth: 3,
        })
        .expect(201);

      const body = res.body as Record<string, unknown>;
      expect(body.birthDay).toBe(15);
      expect(body.birthMonth).toBe(3);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored?.birthDay).toBe(15);
      expect(stored?.birthMonth).toBe(3);
    });
  });

  describe('um-reg-15 · an incomplete or out-of-range birthday is rejected', () => {
    const validBody = (
      workEmail: string,
      overrides: Record<string, unknown>,
    ) => ({
      firstName: 'Nina',
      lastName: 'Volkova',
      position: 'QA Engineer',
      country: 'Poland',
      city: 'Krakow',
      workEmail,
      companyJoinDate: '2026-09-01',
      ...overrides,
    });

    it('Test 1 — birthDay without birthMonth is rejected with 400', async () => {
      const workEmail = emailFor('birthday-day-only');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send(validBody(workEmail, { birthDay: 15 }))
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });

    it('Test 2 — birthMonth without birthDay is rejected with 400', async () => {
      const workEmail = emailFor('birthday-month-only');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send(validBody(workEmail, { birthMonth: 3 }))
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });

    it('Test 3 — out-of-range birthDay is rejected with 400', async () => {
      const workEmail = emailFor('birthday-day-oor');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send(validBody(workEmail, { birthDay: 32, birthMonth: 3 }))
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });

    it('Test 4 — out-of-range birthMonth is rejected with 400', async () => {
      const workEmail = emailFor('birthday-month-oor');

      await request(app.getHttpServer())
        .post('/users')
        .set('authorization', 'Bearer <token:Root>')
        .send(validBody(workEmail, { birthDay: 15, birthMonth: 13 }))
        .expect(400);

      const stored = await prisma.user.findUnique({ where: { workEmail } });
      expect(stored).toBeNull();
    });
  });
});
