import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-3 Stage 2 — ACM3-II-12. Reporting visited state is path-local: two
 * target walks may share ancestors without one target's walk denying the
 * other, while a repeat on one target's own path still denies Reporting.
 */
describe('ACM-3 Stage 2 — Reporting path-local visited state (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm3-path-${uuidv7()}`;
  const ids: Record<string, string> = {};
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
        isActive: true,
        createdBy: ids.FixtureOwner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  /**
   * The cyclic branch must terminate as a readable test failure rather than
   * leaving Jest waiting on a recursive query indefinitely.
   */
  const resolveWithin = (viewerId: string, employeeIds: string[]) => {
    let hangTimer: ReturnType<typeof setTimeout> | undefined;
    const hangGuard = new Promise<never>((_, reject) => {
      hangTimer = setTimeout(
        () =>
          reject(
            new Error(
              'resolveAudiences did not complete within 5s — the walk did not terminate on a cycle',
            ),
          ),
        5000,
      );
    });

    return Promise.race([
      facade.resolveAudiences(viewerId, employeeIds),
      hangGuard,
    ]).finally(() => {
      if (hangTimer !== undefined) {
        clearTimeout(hangTimer);
      }
    });
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

    await createUser('Ada');
    await createUser('Borys');
    await createUser('Cyril');
    await createUser('Dmytro');
    await createUser('Eva');
    await createUser('Fedir');
    await createUser('Hlib');

    await prisma.relationship.createMany({
      data: [
        { userId: ids.Ada, type: 'direct', reportsToUserId: ids.Cyril },
        { userId: ids.Borys, type: 'direct', reportsToUserId: ids.Cyril },
        { userId: ids.Cyril, type: 'direct', reportsToUserId: ids.Dmytro },
        { userId: ids.Eva, type: 'direct', reportsToUserId: ids.Fedir },
        { userId: ids.Fedir, type: 'direct', reportsToUserId: ids.Hlib },
        { userId: ids.Hlib, type: 'direct', reportsToUserId: ids.Fedir },
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

  describe('ACM3-II-12 · two targets sharing every ancestor above them', () => {
    it('keeps Reporting for both targets regardless of input order', async () => {
      const expected = new Map<string, Set<Audience>>([
        [ids.Ada, new Set<Audience>(['reporting'])],
        [ids.Borys, new Set<Audience>(['reporting'])],
      ]);

      const forward = await facade.resolveAudiences(ids.Dmytro, [
        ids.Ada,
        ids.Borys,
      ]);
      expect(forward).toEqual(expected);

      const reversed = await facade.resolveAudiences(ids.Dmytro, [
        ids.Borys,
        ids.Ada,
      ]);
      expect(reversed).toEqual(expected);
    });
  });

  describe('ACM3-II-12 · a cyclic target alongside shared-ancestor targets', () => {
    it('denies only the cyclic path in one bulk request', async () => {
      const audiences = await resolveWithin(ids.Dmytro, [
        ids.Ada,
        ids.Borys,
        ids.Eva,
      ]);

      expect(audiences).toEqual(
        new Map<string, Set<Audience>>([
          [ids.Ada, new Set<Audience>(['reporting'])],
          [ids.Borys, new Set<Audience>(['reporting'])],
          [ids.Eva, new Set<Audience>(['colleague'])],
        ]),
      );
    });
  });
});
