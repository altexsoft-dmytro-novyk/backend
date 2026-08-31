import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('ACM-3 Stage 2 — inactive identity audience resolution (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm3-${uuidv7()}`;
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
    expect([...(audiences.get(employeeId) ?? [])].sort()).toEqual(expected);
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    }).compile();
    await moduleFixture.init();

    facade = moduleFixture.get(AccessControlFacade);
    prisma = moduleFixture.get(PrismaService);

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

    await createUser('ViewerAlice');
    await createUser('ViewerBob');
    await createUser('InactiveOwen', false);
    await createUser('BridgeAlice');
    await createUser('BridgeBob');
    await createUser('DeadNode', false);
    await createUser('BridgeCarol');
    await createUser('TargetBob');
    await createUser('TargetAlice');
    await createUser('Dismissed', false);

    await prisma.relationship.createMany({
      data: [
        {
          userId: ids.ViewerAlice,
          type: 'direct',
          reportsToUserId: ids.ViewerBob,
        },
        {
          userId: ids.ViewerBob,
          type: 'direct',
          reportsToUserId: ids.InactiveOwen,
        },
        {
          userId: ids.BridgeAlice,
          type: 'direct',
          reportsToUserId: ids.BridgeBob,
        },
        {
          userId: ids.BridgeBob,
          type: 'direct',
          reportsToUserId: ids.DeadNode,
        },
        {
          userId: ids.DeadNode,
          type: 'direct',
          reportsToUserId: ids.BridgeCarol,
        },
        {
          userId: ids.TargetAlice,
          type: 'direct',
          reportsToUserId: ids.TargetBob,
        },
        {
          userId: ids.Dismissed,
          type: 'direct',
          reportsToUserId: ids.TargetBob,
        },
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

  describe('ACM3-II-01 · inactive viewer at the top of an active chain', () => {
    it('returns an empty audience set for the active target', async () => {
      const audiences = await facade.resolveAudiences(ids.InactiveOwen, [
        ids.ViewerAlice,
      ]);

      expectAudienceEntry(audiences, ids.ViewerAlice, []);
    });

    it('returns an empty audience set when the inactive viewer requests themselves', async () => {
      const audiences = await facade.resolveAudiences(ids.InactiveOwen, [
        ids.InactiveOwen,
      ]);

      expectAudienceEntry(audiences, ids.InactiveOwen, []);
    });
  });

  describe('ACM3-II-02 · inactive bridge stops traversal', () => {
    it('denies Reporting and leaves Colleague as the floor above the dead bridge', async () => {
      const audiences = await facade.resolveAudiences(ids.BridgeCarol, [
        ids.BridgeAlice,
      ]);

      expectAudienceEntry(audiences, ids.BridgeAlice, ['colleague']);
    });

    it('keeps the live direct-manager segment below the dead bridge as Reporting', async () => {
      const audiences = await facade.resolveAudiences(ids.BridgeBob, [
        ids.BridgeAlice,
      ]);

      expectAudienceEntry(audiences, ids.BridgeAlice, ['reporting']);
    });
  });

  describe('ACM3-II-03 · inactive target below an active manager', () => {
    it('returns an empty set for the inactive target without affecting the active sibling', async () => {
      const audiences = await facade.resolveAudiences(ids.TargetBob, [
        ids.Dismissed,
        ids.TargetAlice,
      ]);

      expectAudienceEntry(audiences, ids.Dismissed, []);
      expectAudienceEntry(audiences, ids.TargetAlice, ['reporting']);
    });
  });
});
