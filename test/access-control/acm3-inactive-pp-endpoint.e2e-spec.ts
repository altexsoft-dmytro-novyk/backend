import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('ACM-3 Stage 2 — inactive direct-PP endpoint audience resolution (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;
  let fixtureOwnerCreated = false;

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

    await createUser('Roman');
    await createUser('Pavlo', false);
    await createUser('Taras', false);
    await createUser('Ulyana');
    await createUser('Solomiya');

    await prisma.relationship.createMany({
      data: [
        {
          userId: ids.Roman,
          type: 'people_partner',
          reportsToUserId: ids.Pavlo,
        },
        {
          userId: ids.Taras,
          type: 'people_partner',
          reportsToUserId: ids.Solomiya,
        },
        {
          userId: ids.Ulyana,
          type: 'people_partner',
          reportsToUserId: ids.Solomiya,
        },
      ],
    });
  });

  afterAll(async () => {
    try {
      if (prisma && fixtureOwnerCreated) {
        const fixtureIds = Object.values(ids);
        await prisma.relationship.deleteMany({
          where: {
            OR: [
              { userId: { in: fixtureIds } },
              { reportsToUserId: { in: fixtureIds } },
            ],
          },
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

  describe('ACM3-II-11 · inactive PP endpoint', () => {
    it('returns an empty set when the assigned PP is inactive', async () => {
      const audiences = await facade.resolveAudiences(ids.Pavlo, [ids.Roman]);

      expect(audiences).toEqual(
        new Map<string, Set<Audience>>([[ids.Roman, new Set<Audience>()]]),
      );
    });

    it('returns an empty set for an inactive target without affecting the active sibling', async () => {
      const audiences = await facade.resolveAudiences(ids.Solomiya, [
        ids.Taras,
        ids.Ulyana,
      ]);

      expect(audiences).toEqual(
        new Map<string, Set<Audience>>([
          [ids.Taras, new Set<Audience>()],
          [ids.Ulyana, new Set<Audience>(['pp'])],
        ]),
      );
    });

    it('denies the inactive PP viewer over every target, including self', async () => {
      const audiences = await facade.resolveAudiences(ids.Pavlo, [
        ids.Roman,
        ids.Ulyana,
        ids.Pavlo,
      ]);

      expect(audiences).toEqual(
        new Map<string, Set<Audience>>([
          [ids.Roman, new Set<Audience>()],
          [ids.Ulyana, new Set<Audience>()],
          [ids.Pavlo, new Set<Audience>()],
        ]),
      );
    });
  });
});
