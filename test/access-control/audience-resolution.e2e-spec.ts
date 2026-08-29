import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import {
  RELATIONSHIP_GRAPH_PORT,
  type RelationshipGraphPort,
} from '../../src/access-control/domain/interfaces/relationship-graph.port';
import {
  ACCESS_CONTROL_PORT,
  type AccessControlPort,
} from '../../src/user-management/domain/interfaces/access-control.port';

// Scenarios: docs/test-cases/access-control-foundation/
//
// Why this suite overrides a provider (and why that is not a fake):
// `ACCESS_CONTROL_PORT` is bound to `InterimAccessControlAdapter` inside
// `user-management.module.ts`, which Access Control must not edit (AD-2).
// The override below binds the REAL facade — real resolver, real Prisma
// adapter, real PostgreSQL, real HTTP router. Nothing about resolution is
// faked; only the composition point moves, because production rebinding is
// User Management's own story.
//
// The allow/deny rule encoded here is the PROVISIONAL mapping recorded in the
// suite README: self/reporting/pp allow, colleague denies. It is an Access
// Control assumption pending answer 3 of the User Management contract request.
class FacadeBackedAccessControlAdapter implements AccessControlPort {
  constructor(private readonly facade: AccessControlFacade) {}

  // Functional-role evaluation is not part of Phase 0. Returning false keeps
  // the slice honest: this adapter speaks only for target-scoped audiences.
  isAllowed(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async isAllowedForTarget(
    userId: string,
    _feature: string,
    targetUserId: string,
  ): Promise<boolean> {
    const audiences = await this.facade.resolveAudiences(userId, [
      targetUserId,
    ]);
    const audience = audiences.get(targetUserId);
    return audience === 'self' || audience === 'reporting' || audience === 'pp';
  }
}

describe('Access Control Phase 0 — audience resolution over GET /users/:id (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const runId = `acf-${Date.now()}`;
  const ids: Record<string, string> = {};
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;
  const asPersona = (persona: string) => `Bearer <token:${ids[persona]}>`;

  // The org graph is created straight through Prisma: no relationship endpoint
  // exists to build it over HTTP, and inventing one would be User Management's
  // decision to make, not this suite's.
  const createUser = async (
    persona: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const created = await prisma.user.create({
      data: {
        firstName: persona,
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor(persona),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: ids.Alice ?? undefined,
        ...overrides,
      } as never,
      select: { id: true },
    });
    ids[persona] = created.id;
    return created.id;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    })
      .overrideProvider(ACCESS_CONTROL_PORT)
      .useFactory({
        factory: (facade: AccessControlFacade) =>
          new FacadeBackedAccessControlAdapter(facade),
        inject: [AccessControlFacade],
      })
      .compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();

    // Alice is created first and self-references through `createdBy`, the same
    // way the bootstrap seed row does — every later fixture points at her.
    const aliceId = uuidv7();
    await prisma.user.create({
      data: {
        id: aliceId,
        firstName: 'Alice',
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor('Alice'),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: aliceId,
      } as never,
      select: { id: true },
    });
    ids.Alice = aliceId;

    await createUser('Bob', { position: 'Unit Manager' });
    await createUser('Carol', { position: 'Director' });
    await createUser('Paula', { position: 'People Partner' });
    await createUser('Hana', { position: 'HR Lead' });
    await createUser('Colin');
    await createUser('Erin');
    await createUser('InactiveMgr', {
      position: 'Unit Manager',
      isActive: false,
    });
    await createUser('Frank', { position: 'Director' });

    await prisma.relationship.createMany({
      data: [
        { userId: ids.Alice, type: 'direct', reportsToUserId: ids.Bob },
        { userId: ids.Bob, type: 'direct', reportsToUserId: ids.Carol },
        {
          userId: ids.Alice,
          type: 'people_partner',
          reportsToUserId: ids.Paula,
        },
        { userId: ids.Paula, type: 'direct', reportsToUserId: ids.Hana },
        { userId: ids.Erin, type: 'direct', reportsToUserId: ids.InactiveMgr },
        { userId: ids.InactiveMgr, type: 'direct', reportsToUserId: ids.Frank },
      ],
    });
  });

  afterAll(async () => {
    // Guarded: when beforeAll fails, cleanup must not throw over the top of the
    // real error and hide why the suite could not start.
    if (prisma) {
      const fixtureIds = Object.values(ids);
      await prisma.relationship.deleteMany({
        where: { userId: { in: fixtureIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: fixtureIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  describe('ACF-AU-01 · Self reads own profile', () => {
    it('returns 200 for the viewer’s own record', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Alice'))
        .expect(200);
    });
  });

  describe('ACF-AU-02 · Direct manager reads a report', () => {
    it('returns 200 for a live direct reports-to edge', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Bob'))
        .expect(200);
    });
  });

  describe('ACF-AU-03 · Manager’s manager reads through the chain', () => {
    it('returns 200 through the recursive direct walk, with no stored pointer', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Carol'))
        .expect(200);
    });
  });

  describe('ACF-AU-04 · Assigned People Partner reads the profile', () => {
    it('returns 200 from the people_partner assignment alone', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Paula'))
        .expect(200);
    });
  });

  describe('ACF-AU-05 · Unrelated colleague is denied', () => {
    it('returns 403 and no profile fields', async () => {
      const response = await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Colin'))
        .expect(403);

      expect(response.body).not.toHaveProperty('workEmail');
      expect(response.body).not.toHaveProperty('firstName');
    });
  });

  describe('ACF-FC-01 · Walk stops at a broken reports-to edge', () => {
    it('denies the ancestor above a deactivated manager', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Erin}`)
        .set('authorization', asPersona('Frank'))
        .expect(403);
    });
  });

  describe('ACF-FC-02 · PP inheritance stops at the assigned partner', () => {
    it('denies the People Partner’s own manager', async () => {
      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Hana'))
        .expect(403);
    });
  });

  describe('ACF-FC-03 · Empty bulk resolves without touching the database', () => {
    it('returns an empty map and issues no query', async () => {
      const facade = app.get(AccessControlFacade);
      const graph = app.get<RelationshipGraphPort>(RELATIONSHIP_GRAPH_PORT);
      const loadFacts = jest.spyOn(graph, 'loadAudienceFacts');

      const audiences = await facade.resolveAudiences(ids.Colin, []);

      expect(audiences.size).toBe(0);
      expect(loadFacts).not.toHaveBeenCalled();
      loadFacts.mockRestore();
    });
  });

  describe('nothing derived is persisted', () => {
    it('leaves no relationship rows behind after resolution', async () => {
      const before = await prisma.relationship.count();

      await request(app.getHttpServer())
        .get(`/users/${ids.Alice}`)
        .set('authorization', asPersona('Carol'))
        .expect(200);

      expect(await prisma.relationship.count()).toBe(before);
    });
  });
});
