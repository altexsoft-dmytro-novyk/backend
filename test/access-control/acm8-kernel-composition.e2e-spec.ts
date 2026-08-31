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
import { InterimAccessControlAdapter } from '../../src/user-management/infrastructure/interim-access-control.adapter';

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
  it('ACM8-KC-02 still resolves ACCESS_CONTROL_PORT to InterimAccessControlAdapter in the same composed container', () => {
    const port = moduleFixture.get<AccessControlPort>(ACCESS_CONTROL_PORT);
    expect(port).toBeInstanceOf(InterimAccessControlAdapter);
    expect(port).not.toBeInstanceOf(AccessControlFacade);
  });

  // docs/test-cases/access-control-kernel/kernel-composition/acm8-kc-03-user-management-behavior-unchanged.md
  it('ACM8-KC-03 leaves GET /users/:id on the interim adapter, unaffected by kernel composition', async () => {
    const created = await request(app.getHttpServer())
      .post('/users')
      .set('authorization', 'Bearer <token:Root>')
      .send({
        firstName: 'Kc03',
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'Poland',
        city: 'Warsaw',
        workEmail: emailFor('kc-03-target'),
        companyJoinDate: '2024-01-01',
      });
    const targetId = (created.body as { id: string }).id;

    // InterimAccessControlAdapter#isAllowedForTarget is `Boolean(userId)`:
    // any authenticated session may read any target. This asserts that
    // exact, unchanged interim decision — not a new access-control result.
    await request(app.getHttpServer())
      .get(`/users/${targetId}`)
      .set('authorization', 'Bearer <token:AnyAuthenticatedViewer>')
      .expect(200);
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
