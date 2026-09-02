import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  ACCESS_CONTROL_PORT,
  type AccessControlPort,
} from '../../src/user-management/domain/interfaces/access-control.port';

/**
 * ACM-8 Stage 2 — CAP-6 deployable kernel composition.
 *
 * Translates only the approved ACM8-KC-01..05 contracts. The application
 * container is built from AppModule ALONE — AccessControlModule is
 * deliberately NOT added to the test module — because CAP-6's subject is
 * whether AppModule's own DI graph now carries AccessControlModule, not
 * whether it can be manually wired into a standalone test module. No
 * repository fake, no provider override, no artificial HTTP endpoint.
 *
 * EXPECTED RED (ACM8-KC-01): AppModule does not import AccessControlModule
 * yet, so AccessControlFacade is not resolvable from this container. That is
 * the exact production behavior ACM-8-production is gated on.
 *
 * ACM8-KC-02/03 realigned 2026-09-01 (UMAC-1 Stage 3): User Management has now
 * rebound ACCESS_CONTROL_PORT to the real AccessControlFacade-backed adapter
 * and deleted interim-access-control.adapter.ts (SPEC CAP-1, AD-21). This file
 * previously imported that concrete class to assert the binding was UNCHANGED;
 * that class is gone and the assertion is inverted. KC-02 now checks the port
 * resolves to the facade-backed adapter (by resolved class name, adding no new
 * cross-context src/ import — the ACCESS_CONTROL_PORT token import is
 * pre-existing and irreducible, see deferred-work.md #83/#85); KC-03 now checks
 * GET /users/:id goes through the real facade (self → 200 enveloped, stranger →
 * 403). The ACM-8 scenario docs acm8-kc-02/03 still describe the old
 * interim-unchanged expectation and are a follow-up realignment for the
 * access-control context.
 */
describe('ACM-8 Stage 2 — CAP-6 kernel composition (PostgreSQL)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let prisma: PrismaService;

  const runId = `acm8-${uuidv7()}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
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
    if (prisma) {
      await prisma.user.deleteMany({
        where: { workEmail: { contains: runId } },
      });
    }
    await app?.close();
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-01-facade-resolves-from-real-container.md
  it('ACM8-KC-01 resolves AccessControlFacade from the real AppModule container with a working decision', async () => {
    const facade = moduleFixture.get(AccessControlFacade);
    expect(facade).toBeInstanceOf(AccessControlFacade);

    // Prove it is a WORKING facade backed by real Prisma adapters and live
    // PostgreSQL facts, not merely resolvable: a well-formed id matching no
    // `users` row derives no audience (fail-closed), per the already-approved
    // ACM3-II-14 contract this facade already implements.
    const missingId = uuidv7();
    const audiences = await facade.resolveAudiences(missingId, [missingId]);
    expect(audiences.get(missingId)).toEqual(new Set());
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-02-interim-adapter-binding-unchanged.md
  // Realigned (UMAC-1 Stage 3): the port is now the real facade-backed adapter.
  it('ACM8-KC-02 resolves ACCESS_CONTROL_PORT to the real AccessControlFacade-backed adapter in the same composed container', () => {
    const port = moduleFixture.get<AccessControlPort>(ACCESS_CONTROL_PORT);
    // Asserted by resolved class name — no concrete cross-context src/ import.
    expect(port?.constructor?.name).toBe('AccessControlFacadeAdapter');
    // It delegates to the facade; it is not the facade itself.
    expect(port).not.toBeInstanceOf(AccessControlFacade);
    expect(typeof port.isAllowed).toBe('function');
    expect(typeof port.isAllowedForTarget).toBe('function');
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-03-user-management-behavior-unchanged.md
  // Realigned (UMAC-1 Stage 3): GET /users/:id now runs through the real facade.
  it('ACM8-KC-03 routes GET /users/:id through the real facade — self reads the S1 card, an unconfirmed viewer is denied', async () => {
    const targetId = uuidv7();
    const target = await prisma.user.create({
      data: {
        id: targetId,
        firstName: 'Kc03',
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'Poland',
        city: 'Warsaw',
        workEmail: emailFor('kc-03-target'),
        companyJoinDate: new Date('2024-01-01'),
        createdBy: targetId,
      },
    });

    // Self resolves a non-empty audience over an active target → 200 with the
    // `{ data, canEdit }` envelope (canEdit false — `user-management:edit`
    // unseeded).
    const selfRead = await request(app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', `Bearer <token:${target.id}>`);
    expect(selfRead.status).toBe(200);
    expect(Object.keys(selfRead.body as object).sort()).toEqual([
      'canEdit',
      'data',
    ]);
    expect((selfRead.body as { canEdit: boolean }).canEdit).toBe(false);

    // An unconfirmed viewer (string id, matches no active User) → empty
    // audience → the guard denies → 403. The interim `Boolean(userId)` leak is
    // gone.
    await request(app.getHttpServer())
      .get(`/users/${target.id}`)
      .set('authorization', 'Bearer <token:AnyAuthenticatedViewer>')
      .expect(403);
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-04-no-http-or-debug-endpoint-added.md
  it('ACM8-KC-04 exposes no Access Control HTTP or debug route', async () => {
    await request(app.getHttpServer()).get('/access-control').expect(404);
    await request(app.getHttpServer()).get('/access-control/debug').expect(404);
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-05-corrected-module-header-comment.md
  it('ACM8-KC-05 no longer conflates AppModule import with ACCESS_CONTROL_PORT rebinding in the module header', () => {
    const source = readFileSync(
      join(__dirname, '../../src/access-control/access-control.module.ts'),
      'utf8',
    );
    // Normalize the leading `//` and line wrapping of the header comment so
    // the check is robust to reflow: the stale claim is that importing this
    // module MEANS rebinding ACCESS_CONTROL_PORT, wherever it wraps.
    const normalizedComment = source
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(normalizedComment).not.toContain(
      'means rebinding ACCESS_CONTROL_PORT',
    );
  });
});
