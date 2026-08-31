import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('ACM-3 Stage 2 — fail-closed identity resolution (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm3-fci-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const missingId = uuidv7();
  const unreadableRelationshipsTable = `relationships_acm3_fci_${uuidv7().replaceAll('-', '')}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (persona: string): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        firstName: persona,
        lastName: 'Fixture',
        position: 'Engineer',
        country: 'PL',
        city: 'Krakow',
        workEmail: emailFor(persona),
        companyJoinDate: new Date('2020-01-01'),
        createdBy: ids.FixtureOwner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  const expectExactAudiences = (
    actual: Map<string, Set<Audience>>,
    expected: Map<string, Set<Audience>>,
  ) => {
    expect(actual).toEqual(expected);
  };

  const withUnreadableRelationshipGraph = async <T>(
    action: () => Promise<T>,
  ): Promise<T> => {
    let renamed = false;
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "relationships" RENAME TO "${unreadableRelationshipsTable}"`,
      );
      renamed = true;
      return await action();
    } finally {
      if (renamed) {
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "${unreadableRelationshipsTable}" RENAME TO "relationships"`,
        );
      }
    }
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

    await createUser('Xenia');
    await createUser('Yaroslav');

    await prisma.relationship.create({
      data: {
        userId: ids.Yaroslav,
        type: 'direct',
        reportsToUserId: ids.Xenia,
      },
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

  describe('ACM3-II-13 · infrastructure failure propagates as an error', () => {
    it('rejects after a healthy reporting result when the graph table becomes unreadable', async () => {
      const healthyAudiences = await facade.resolveAudiences(ids.Xenia, [
        ids.Yaroslav,
      ]);

      expectExactAudiences(
        healthyAudiences,
        new Map<string, Set<Audience>>([
          [ids.Yaroslav, new Set<Audience>(['reporting'])],
        ]),
      );

      await expect(
        withUnreadableRelationshipGraph(() =>
          facade.resolveAudiences(ids.Xenia, [ids.Yaroslav]),
        ),
      ).rejects.toThrow();
    });

    it('rejects the whole call instead of returning a partial map after a graph failure', async () => {
      await expect(
        withUnreadableRelationshipGraph(() =>
          facade.resolveAudiences(ids.Xenia, [ids.Yaroslav, ids.Xenia]),
        ),
      ).rejects.toThrow();
    });
  });

  describe('ACM3-II-14 · missing viewer and target derive no audience', () => {
    it('returns an empty set for a missing viewer over a real target', async () => {
      expect(
        await prisma.user.findUnique({ where: { id: missingId } }),
      ).toBeNull();

      const audiences = await facade.resolveAudiences(missingId, [
        ids.Yaroslav,
      ]);

      expectExactAudiences(
        audiences,
        new Map<string, Set<Audience>>([[ids.Yaroslav, new Set<Audience>()]]),
      );
    });

    it('keeps a missing target key with an empty set beside a reporting target', async () => {
      const audiences = await facade.resolveAudiences(ids.Xenia, [
        missingId,
        ids.Yaroslav,
      ]);

      expectExactAudiences(
        audiences,
        new Map<string, Set<Audience>>([
          [missingId, new Set<Audience>()],
          [ids.Yaroslav, new Set<Audience>(['reporting'])],
        ]),
      );
    });

    it('returns an empty set when a missing viewer requests that same missing id', async () => {
      const audiences = await facade.resolveAudiences(missingId, [missingId]);

      expectExactAudiences(
        audiences,
        new Map<string, Set<Audience>>([[missingId, new Set<Audience>()]]),
      );
    });
  });
});
