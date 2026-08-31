import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-3 Stage 2 — the chain-termination taxonomy pair CAP-1 requires:
 * ACM3-II-09 (an ABSENT manager edge is a clean end) and ACM3-II-10 (an
 * INACTIVE endpoint above a proven viewer is a clean end).
 *
 * ACM3-II-09 is the positive control for the whole termination rule — every
 * other scenario in the group asserts a denial, so without this one a
 * `return new Set()` resolver would satisfy the group while breaking the
 * audience model outright.
 *
 * ACM3-II-10 records verified, unchanged behavior (see the scenario doc's
 * "current vs required" section): today's resolver already grants Reporting
 * for this shape, and CAP-1's rewrite must not regress it into a denial.
 *
 * Scope: these two scenarios only. ACM3-II-06/07/08 are covered in
 * acm3-cycle-acyclicity.e2e-spec.ts and are not restated here.
 */
describe('ACM-3 Stage 2 — chain-termination taxonomy (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;
  let fixtureOwnerCreated = false;

  const runId = `acm3-term-${uuidv7()}`;
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

    // ACM3-II-09 — Hana -> Grzegorz -> Igor, Igor has no manager edge at all.
    await createUser('Hana');
    await createUser('Grzegorz');
    await createUser('Igor');

    // ACM3-II-10 — Jonas -> Klara -> Milo (inactive) -> Nika.
    await createUser('Jonas');
    await createUser('Klara');
    await createUser('Milo', false);
    await createUser('Nika');

    await prisma.relationship.createMany({
      data: [
        { userId: ids.Hana, type: 'direct', reportsToUserId: ids.Grzegorz },
        {
          userId: ids.Grzegorz,
          type: 'direct',
          reportsToUserId: ids.Igor,
        },

        { userId: ids.Jonas, type: 'direct', reportsToUserId: ids.Klara },
        { userId: ids.Klara, type: 'direct', reportsToUserId: ids.Milo },
        { userId: ids.Milo, type: 'direct', reportsToUserId: ids.Nika },
      ],
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

  describe('ACM3-II-09 · an absent manager edge is a clean end', () => {
    it('grants Reporting after a clean top-of-tree termination', async () => {
      const audiences = await facade.resolveAudiences(ids.Igor, [ids.Hana]);

      // Two hops, chain ends cleanly above the viewer (Igor has no
      // `direct` row at all): provisional proof becomes final.
      expectAudienceEntry(audiences, ids.Hana, ['reporting']);
    });

    it('grants Reporting for the direct-report degenerate case, walking past viewer proof to the absent edge', async () => {
      const audiences = await facade.resolveAudiences(ids.Grzegorz, [ids.Hana]);

      // One hop proves Grzegorz; the walk still has to continue above him
      // to Igor's absent edge before the grant is final.
      expectAudienceEntry(audiences, ids.Hana, ['reporting']);
    });
  });

  describe('ACM3-II-10 · an inactive endpoint above a proven viewer is a clean end', () => {
    it('grants Reporting when the chain terminates at an inactive endpoint above the viewer', async () => {
      const audiences = await facade.resolveAudiences(ids.Klara, [ids.Jonas]);

      // Jonas proves Klara at hop one; Klara's manager edge exists but its
      // endpoint Milo is inactive, so it is unusable and treated as absent
      // — a clean end by the same rule as II-09. This test passes today
      // (see the scenario doc's "current vs required" section) and must
      // keep passing: it guards against a rewrite that regresses this into
      // a denial.
      expectAudienceEntry(audiences, ids.Jonas, ['reporting']);
    });

    it('does not make anything above the dead node reachable', async () => {
      const audiences = await facade.resolveAudiences(ids.Nika, [
        ids.Jonas,
        ids.Klara,
      ]);

      // Nika sits above the dead node Milo; the walk never reaches her for
      // either Jonas or Klara. Both parties are active in both pairs, so
      // the entries are the Colleague floor, not an empty Set.
      expectAudienceEntry(audiences, ids.Jonas, ['colleague']);
      expectAudienceEntry(audiences, ids.Klara, ['colleague']);
    });

    it('treats the dead node as an identity failure when it is the target, not as a Colleague floor', async () => {
      const audiences = await facade.resolveAudiences(ids.Klara, [ids.Milo]);

      // As a bridge (previous tests) an inactive endpoint is an unusable
      // edge; as a target it is an identity failure per ACM3-II-03, yielding
      // an empty Set rather than the Colleague floor.
      expectAudienceEntry(audiences, ids.Milo, []);
    });
  });
});
