import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

type RelationNameRow = { name: string | null };

describe('ACM-3 Stage 2 — fail-closed identity resolution (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;
  let fixtureOwnerCreated = false;

  const runId = `acm3-fci-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const missingId = uuidv7();
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

  const withBlockedRelationshipGraph = async <T>(
    action: () => Promise<T>,
  ): Promise<T> => {
    return prisma.$transaction(
      async (tx) => {
        // A second adapter transaction can still validate identities, set its
        // own 2s statement timeout, and then fail on the real graph read. The
        // lock is transaction-scoped, so PostgreSQL releases it on success,
        // rejection, connection loss, or process termination; the canonical
        // table name is never changed for another test process.
        await tx.$executeRawUnsafe(
          `LOCK TABLE "relationships" IN ACCESS EXCLUSIVE MODE`,
        );
        return action();
      },
      { timeout: 10_000 },
    );
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
    fixtureOwnerCreated = true;

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
    try {
      if (prisma && fixtureOwnerCreated) {
        const fixtureIds = Object.values(ids);
        await prisma.relationship.deleteMany({
          where: { userId: { in: fixtureIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: fixtureIds } },
        });
      }
    } finally {
      if (moduleFixture) {
        await moduleFixture.close();
      }
    }
  });

  describe('ACM3-II-13 · infrastructure failure propagates as an error', () => {
    it('rejects after a healthy reporting result when the graph table becomes unreadable', async () => {
      let relationNameDuringFailure: string | null | undefined;
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
        withBlockedRelationshipGraph(async () => {
          const [relation] = await prisma.$queryRawUnsafe<RelationNameRow[]>(
            `SELECT to_regclass('public.relationships')::text AS name`,
          );
          relationNameDuringFailure = relation?.name;

          return facade.resolveAudiences(ids.Xenia, [ids.Yaroslav]);
        }),
      ).rejects.toThrow();

      // Failure injection must not rename or remove the shared relation:
      // other test processes may use the same local database. Keep this
      // outside the rejected action so an assertion error cannot masquerade
      // as the infrastructure rejection the test is meant to observe.
      expect(relationNameDuringFailure).toBe('relationships');
    });

    it('rejects the whole call instead of returning a partial map after a graph failure', async () => {
      await expect(
        withBlockedRelationshipGraph(() =>
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
