import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import {
  IDENTITY_PORT,
  type IdentityPort,
} from '../../src/access-control/domain/interfaces/identity.port';
import {
  RELATIONSHIP_GRAPH_PORT,
  type RelationshipGraphPort,
} from '../../src/access-control/domain/interfaces/relationship-graph.port';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-3 Stage 2 — bulk-input contract guards for CAP-1:
 * ACM3-II-04 (empty target list short-circuits before any read) and
 * ACM3-II-05 (duplicate targets and viewer ids collapse to one map key).
 *
 * Both scenarios are regression guards for already-shipped behavior — not
 * committed-red tests. CAP-1 rewrites the top of AudienceResolverService.resolve
 * and these shapes are the ones most likely to regress silently.
 */
describe('ACM-3 Stage 2 — bulk input contract (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;
  let graph: RelationshipGraphPort;
  let identity: IdentityPort;

  const runId = `acm3-bulk-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (
    persona: string,
    isActive = true,
  ): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        firstName: persona,
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor(persona),
        companyJoinDate: new Date('2020-01-01'),
        isActive,
        createdBy: ids.FixtureOwner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  const expectAudienceEntry = (
    audiences: Map<string, Set<Audience>>,
    employeeId: string,
    expected: Audience[],
  ) => {
    expect(audiences.has(employeeId)).toBe(true);
    expect([...(audiences.get(employeeId) ?? [])].sort()).toEqual(
      [...expected].sort(),
    );
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    }).compile();
    await moduleFixture.init();

    facade = moduleFixture.get(AccessControlFacade);
    prisma = moduleFixture.get(PrismaService);
    graph = moduleFixture.get<RelationshipGraphPort>(RELATIONSHIP_GRAPH_PORT);
    identity = moduleFixture.get<IdentityPort>(IDENTITY_PORT);

    const fixtureOwnerId = uuidv7();
    await prisma.user.create({
      data: {
        id: fixtureOwnerId,
        firstName: 'Fixture',
        lastName: 'Owner',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor('fixture-owner'),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: fixtureOwnerId,
      },
      select: { id: true },
    });
    ids.FixtureOwner = fixtureOwnerId;

    // ACM3-II-04 — Nora is an active manager so a graph read would be observable.
    await createUser('Nora');
    await createUser('NoraReport');

    // ACM3-II-05 — Mila manages Dana; no PP edge so key collapse is unambiguous.
    await createUser('Mila');
    await createUser('Dana');
    await createUser('InactiveOwen', false);

    await prisma.relationship.createMany({
      data: [
        {
          userId: ids.NoraReport,
          type: 'direct',
          reportsToUserId: ids.Nora,
        },
        { userId: ids.Dana, type: 'direct', reportsToUserId: ids.Mila },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      const fixtureIds = Object.values(ids);
      await prisma.relationship.deleteMany({
        where: { userId: { in: fixtureIds } },
      });
      await prisma.user.deleteMany({
        where: {
          id: { in: fixtureIds.filter((id) => id !== ids.FixtureOwner) },
        },
      });
      await prisma.user.delete({ where: { id: ids.FixtureOwner } });
    }
    if (moduleFixture) {
      await moduleFixture.close();
    }
  });

  describe('ACM3-II-04 · empty target list returns an empty map with no relationship-graph read', () => {
    it('short-circuits an active viewer before any graph read', async () => {
      const loadFacts = jest.spyOn(graph, 'loadAudienceFacts');

      const audiences = await facade.resolveAudiences(ids.Nora, []);

      expect(audiences.size).toBe(0);
      expect(loadFacts).not.toHaveBeenCalled();
      loadFacts.mockRestore();
    });

    it('short-circuits before identity validation when the viewer would fail', async () => {
      const loadFacts = jest.spyOn(graph, 'loadAudienceFacts');
      const findActive = jest.spyOn(identity, 'findActiveUserIds');

      const audiences = await facade.resolveAudiences(ids.InactiveOwen, []);

      expect(audiences.size).toBe(0);
      expect(loadFacts).not.toHaveBeenCalled();
      expect(findActive).not.toHaveBeenCalled();
      loadFacts.mockRestore();
      findActive.mockRestore();
    });
  });

  describe('ACM3-II-05 · duplicate requested targets collapse to one map key', () => {
    it('collapses repeated target and viewer ids to two keys with correct audiences', async () => {
      const audiences = await facade.resolveAudiences(ids.Mila, [
        ids.Dana,
        ids.Dana,
        ids.Mila,
        ids.Mila,
        ids.Dana,
      ]);

      expect(audiences.size).toBe(2);
      expectAudienceEntry(audiences, ids.Dana, ['reporting']);
      expectAudienceEntry(audiences, ids.Mila, ['self']);
    });

    it('deduplicates before the graph read so the port sees each distinct target once', async () => {
      const loadFacts = jest.spyOn(graph, 'loadAudienceFacts');

      await facade.resolveAudiences(ids.Mila, [ids.Dana, ids.Dana, ids.Mila]);

      expect(loadFacts).toHaveBeenCalledTimes(1);
      expect(loadFacts).toHaveBeenCalledWith(ids.Mila, [ids.Dana]);
      loadFacts.mockRestore();
    });
  });
});
