import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-3 Stage 2 — the cycle-acyclicity scenarios of CAP-1, covering the three
 * approved cases the first Stage-2 suite does not:
 * ACM3-II-06 (a repeat BEFORE viewer proof), ACM3-II-07 (a repeat AFTER
 * viewer proof) and ACM3-II-08 (a viewer who is herself inside the cycle).
 *
 * ACM3-II-07 and ACM3-II-08 were committed red on purpose. Today's recursive
 * CTE decides Reporting by REACHABILITY — it collects every ancestor per
 * target and asks `WHERE ancestor_id = <viewer>` — so a viewer found anywhere
 * on a cyclic chain is proven by the very cycle that should disqualify her.
 * CAP-1 makes viewer proof provisional: the walk continues to chain
 * termination and Reporting is granted only when that target's whole walked
 * chain terminates without repeating a node.
 *
 * ACM3-II-06 is deliberately NOT a red test. Its viewer is off the chain
 * entirely, so `WHERE ancestor_id = <viewer>` already matches nothing and the
 * `UNION` recursive term already halts on the duplicate row — the scenario
 * doc records the answer as code-verified unchanged. Its subject is
 * termination rather than the audience value: a resolver that drops
 * path-local visited state does not answer this case wrongly, it fails to
 * answer at all.
 *
 * Scope: these three scenarios only. The identity cases (ACM3-II-01..03) are
 * green in acm3-inactive-identity.e2e-spec.ts and are not restated here.
 */
describe('ACM-3 Stage 2 — Reporting acyclicity (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm3-cyc-${uuidv7()}`;
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
   * A cyclic graph is the one shape where a wrong implementation does not
   * return a wrong answer — it fails to return at all. `SET LOCAL
   * statement_timeout = '2s'` guards the SQL walk, but a walk moved into
   * application code would have no such guard, so the race makes
   * non-termination a fast, readable failure instead of a hung suite.
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

    // ACM3-II-06 — the cycle sits above the TARGET; the viewer is off it.
    await createUser('Rhea');
    await createUser('Kai');
    await createUser('Lena');
    await createUser('Sasha');
    await createUser('Tess');

    // ACM3-II-07 — the cycle sits ABOVE the viewer.
    await createUser('Piotr');
    await createUser('Quinn');
    await createUser('Vera');
    await createUser('Nils');
    await createUser('Olek');

    // ACM3-II-08 — the viewer is one of the two cycle members.
    await createUser('Ivan');
    await createUser('Yulia');
    await createUser('Zoran');

    await prisma.relationship.createMany({
      data: [
        // Kai and Lena are the smallest constructible cycle: one `direct` row
        // per person makes the upward walk a linked list, so two nodes is the
        // shortest repeat that is not a self-reference.
        { userId: ids.Rhea, type: 'direct', reportsToUserId: ids.Kai },
        { userId: ids.Kai, type: 'direct', reportsToUserId: ids.Lena },
        { userId: ids.Lena, type: 'direct', reportsToUserId: ids.Kai },
        // Tess is the clean-chain control resolved in the same bulk call.
        { userId: ids.Tess, type: 'direct', reportsToUserId: ids.Sasha },

        { userId: ids.Piotr, type: 'direct', reportsToUserId: ids.Vera },
        { userId: ids.Quinn, type: 'direct', reportsToUserId: ids.Vera },
        { userId: ids.Vera, type: 'direct', reportsToUserId: ids.Nils },
        { userId: ids.Nils, type: 'direct', reportsToUserId: ids.Olek },
        { userId: ids.Olek, type: 'direct', reportsToUserId: ids.Nils },
        // Quinn's direct-PP edge: it must survive the Reporting denial.
        {
          userId: ids.Quinn,
          type: 'people_partner',
          reportsToUserId: ids.Vera,
        },

        { userId: ids.Ivan, type: 'direct', reportsToUserId: ids.Yulia },
        { userId: ids.Yulia, type: 'direct', reportsToUserId: ids.Zoran },
        { userId: ids.Zoran, type: 'direct', reportsToUserId: ids.Yulia },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      const fixtureIds = Object.values(ids);
      // Relationships first: the endpoint foreign key is ON DELETE RESTRICT,
      // and in a cycle every user is some other user's endpoint.
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

  describe('ACM3-II-06 · a repeated node reached before viewer proof', () => {
    it('denies Reporting when the walk repeats a node without ever reaching the viewer', async () => {
      const audiences = await resolveWithin(ids.Sasha, [ids.Rhea]);

      // Rhea -> Kai -> Lena -> Kai: the repeat ends the walk, and Sasha is
      // not on that chain at any point, so she is never proven. Both parties
      // are active, so the entry is the Colleague floor, not an empty Set.
      expectAudienceEntry(audiences, ids.Rhea, ['colleague']);
    });

    it('confines the denial to the cyclic target within a bulk call', async () => {
      const audiences = await resolveWithin(ids.Sasha, [ids.Rhea, ids.Tess]);

      expectAudienceEntry(audiences, ids.Rhea, ['colleague']);
      // Tess's chain terminates cleanly at Sasha in the same request, so the
      // repeat denies one target's Reporting rather than poisoning the batch.
      expectAudienceEntry(audiences, ids.Tess, ['reporting']);
    });
  });

  describe('ACM3-II-07 · a repeated node above a proven viewer', () => {
    it('denies Reporting when the chain above the proven viewer repeats a node', async () => {
      const audiences = await resolveWithin(ids.Vera, [ids.Piotr]);

      // Viewer proof at hop one is provisional: the walk continues
      // Nils -> Olek -> Nils, which repeats, so the chain never terminated
      // cleanly. Both parties are active, so the entry is the Colleague floor
      // rather than an empty Set.
      expectAudienceEntry(audiences, ids.Piotr, ['colleague']);
    });

    it('keeps direct PP for a target whose Reporting the cycle denies', async () => {
      const audiences = await resolveWithin(ids.Vera, [ids.Quinn]);

      // PP is evaluated independently of the Reporting denial, and Colleague
      // is absent because a stronger valid audience remains.
      expectAudienceEntry(audiences, ids.Quinn, ['pp']);
    });

    it('resolves Self, PP and the denial independently in one bulk call', async () => {
      const audiences = await resolveWithin(ids.Vera, [
        ids.Piotr,
        ids.Quinn,
        ids.Vera,
      ]);

      expectAudienceEntry(audiences, ids.Piotr, ['colleague']);
      expectAudienceEntry(audiences, ids.Quinn, ['pp']);
      expectAudienceEntry(audiences, ids.Vera, ['self']);
    });
  });

  describe('ACM3-II-08 · a viewer inside the cycle', () => {
    it('denies Reporting for a target below a viewer who sits inside the cycle', async () => {
      const audiences = await resolveWithin(ids.Yulia, [ids.Ivan]);

      // Ivan -> Yulia (proof) -> Zoran -> Yulia: the chain closes on the
      // viewer instead of terminating.
      expectAudienceEntry(audiences, ids.Ivan, ['colleague']);
    });

    it("counts the target itself as a visited node when the walk returns to it", async () => {
      const audiences = await resolveWithin(ids.Yulia, [ids.Zoran]);

      // Zoran -> Yulia (proof) -> Zoran: the repeat is the walk's own start
      // node. An implementation that seeded its visited set with the first
      // ancestor rather than the target would pass the previous test and fail
      // this one.
      expectAudienceEntry(audiences, ids.Zoran, ['colleague']);
    });

    it('still resolves Self for a viewer who is inside a cycle', async () => {
      const audiences = await resolveWithin(ids.Yulia, [
        ids.Ivan,
        ids.Zoran,
        ids.Yulia,
      ]);

      expectAudienceEntry(audiences, ids.Ivan, ['colleague']);
      expectAudienceEntry(audiences, ids.Zoran, ['colleague']);
      // Self is settled by confirmed identity, never by the state of a walk.
      expectAudienceEntry(audiences, ids.Yulia, ['self']);
    });
  });
});
