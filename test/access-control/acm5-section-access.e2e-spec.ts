import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

type SectionAccess = 'none' | 'read' | 'write';

type SectionAccessFacade = {
  canAccessSection(
    viewerId: string,
    section: string,
    targetEmployeeId: string,
  ): Promise<SectionAccess>;
};

/**
 * ACM-5 Stage 2 — CAP-5 base S1/S10/S11 section access.
 *
 * Translates only the approved ACM5-SA-01..09 contracts through the real
 * AccessControlFacade/AccessControlModule/Prisma/PostgreSQL boundary. The
 * tests deliberately use no repository fake, provider override, or HTTP
 * endpoint. EXPECTED RED: AccessControlFacade has no canAccessSection public
 * method yet; the missing method is the production behavior this stage gates.
 */
describe('ACM-5 Stage 2 — CAP-5 section access (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm5-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (persona: string, isActive = true): Promise<string> => {
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

  const canAccess = (
    viewerId: string,
    section: string,
    targetEmployeeId: string,
  ): Promise<SectionAccess> =>
    (facade as AccessControlFacade & SectionAccessFacade).canAccessSection(
      viewerId,
      section,
      targetEmployeeId,
    );

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

    await createUser('Self');
    await createUser('ColleagueViewer');
    await createUser('ColleagueTarget');
    await createUser('ReportingViewer');
    await createUser('ReportingTarget');
    await createUser('PpViewer');
    await createUser('PpTarget');
    await createUser('MergedViewer');
    await createUser('MergedTarget');
    await createUser('InactiveViewer', false);

    await prisma.relationship.createMany({
      data: [
        {
          userId: ids.ReportingTarget,
          type: 'direct',
          reportsToUserId: ids.ReportingViewer,
        },
        {
          userId: ids.PpTarget,
          type: 'people_partner',
          reportsToUserId: ids.PpViewer,
        },
        {
          userId: ids.MergedTarget,
          type: 'direct',
          reportsToUserId: ids.MergedViewer,
        },
        {
          userId: ids.MergedTarget,
          type: 'people_partner',
          reportsToUserId: ids.MergedViewer,
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
        where: { id: { in: fixtureIds.filter((id) => id !== ids.FixtureOwner) } },
      });
      await prisma.user.delete({ where: { id: ids.FixtureOwner } });
    }
    await moduleFixture?.close();
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-01-s1-self-or-colleague-read.md
  it('ACM5-SA-01 returns S1 read for exactly Self or Colleague', async () => {
    await expect(canAccess(ids.Self, 'S1', ids.Self)).resolves.toBe('read');
    await expect(
      canAccess(ids.ColleagueViewer, 'S1', ids.ColleagueTarget),
    ).resolves.toBe('read');
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-02-s1-reporting-or-pp-write.md
  it('ACM5-SA-02 returns S1 write for Reporting or direct PP', async () => {
    await expect(
      canAccess(ids.ReportingViewer, 'S1', ids.ReportingTarget),
    ).resolves.toBe('write');
    await expect(canAccess(ids.PpViewer, 'S1', ids.PpTarget)).resolves.toBe(
      'write',
    );
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-03-s10-all-phase-zero-audiences-read.md
  it('ACM5-SA-03 returns S10 read, never write or none, for every Phase-0 audience', async () => {
    await expect(canAccess(ids.Self, 'S10', ids.Self)).resolves.toBe('read');
    await expect(
      canAccess(ids.ColleagueViewer, 'S10', ids.ColleagueTarget),
    ).resolves.toBe('read');
    await expect(
      canAccess(ids.ReportingViewer, 'S10', ids.ReportingTarget),
    ).resolves.toBe('read');
    await expect(canAccess(ids.PpViewer, 'S10', ids.PpTarget)).resolves.toBe(
      'read',
    );
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-04-s11-all-phase-zero-audiences-read.md
  it('ACM5-SA-04 returns S11 read, never write or none, for every Phase-0 audience', async () => {
    await expect(canAccess(ids.Self, 'S11', ids.Self)).resolves.toBe('read');
    await expect(
      canAccess(ids.ColleagueViewer, 'S11', ids.ColleagueTarget),
    ).resolves.toBe('read');
    await expect(
      canAccess(ids.ReportingViewer, 'S11', ids.ReportingTarget),
    ).resolves.toBe('read');
    await expect(canAccess(ids.PpViewer, 'S11', ids.PpTarget)).resolves.toBe(
      'read',
    );
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-05-strongest-merged-audience-wins.md
  it('ACM5-SA-05 returns the strongest result for a Reporting plus PP set', async () => {
    await expect(
      canAccess(ids.MergedViewer, 'S1', ids.MergedTarget),
    ).resolves.toBe('write');
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-06-unsupported-section-returns-none.md
  it('ACM5-SA-06 returns none successfully for every unsupported section string', async () => {
    await expect(
      canAccess(ids.ReportingViewer, 'S5', ids.ReportingTarget),
    ).resolves.toBe('none');
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-07-missing-target-returns-none.md
  it('ACM5-SA-07 returns none successfully for a missing target in every supported section', async () => {
    const missingTargetId = uuidv7();

    await expect(
      canAccess(ids.ReportingViewer, 'S1', missingTargetId),
    ).resolves.toBe('none');
    await expect(
      canAccess(ids.ReportingViewer, 'S10', missingTargetId),
    ).resolves.toBe('none');
    await expect(
      canAccess(ids.ReportingViewer, 'S11', missingTargetId),
    ).resolves.toBe('none');
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-08-empty-audiences-return-none.md
  it('ACM5-SA-08 returns none for every supported section when Phase-0 resolves no audience', async () => {
    await expect(
      canAccess(ids.InactiveViewer, 'S1', ids.ReportingTarget),
    ).resolves.toBe('none');
    await expect(
      canAccess(ids.InactiveViewer, 'S10', ids.ReportingTarget),
    ).resolves.toBe('none');
    await expect(
      canAccess(ids.InactiveViewer, 'S11', ids.ReportingTarget),
    ).resolves.toBe('none');
  });

  // docs/test-cases/access-control-kernel/section-access/acm5-sa-09-audience-resolution-error-propagates.md
  it('ACM5-SA-09 rejects when live audience resolution encounters a PostgreSQL error', async () => {
    const hiddenName = `relationships_acm5_hidden_${uuidv7().replaceAll('-', '')}`;
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "relationships" RENAME TO "${hiddenName}"`,
    );
    try {
      await expect(
        canAccess(ids.ReportingViewer, 'S1', ids.ReportingTarget),
      ).rejects.toBeDefined();
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${hiddenName}" RENAME TO "relationships"`,
      );
    }
  });
});
