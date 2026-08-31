import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import type { Audience } from '../../src/access-control/domain/audience';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-4R Stage 2 — CAP-2 multi-audience real-PostgreSQL evidence.
 *
 * Translates the six approved Stage-1 contracts (ACM4R-MA-01..06,
 * docs/test-cases/access-control-kernel/multi-audience/), unmodified, into
 * direct-facade integration assertions. Every case goes through the real
 * `AccessControlFacade` bound by the real `AccessControlModule`, over real
 * Prisma adapters and migrated PostgreSQL — no fake repository, provider
 * override, artificial HTTP route, or direct resolver call bypassing the
 * facade.
 *
 * This is validation-only evidence (testing-strategy.md's AD-1 exception):
 * it changes no production code either way, and a red result here is a valid,
 * committed-red dispatch outcome reflecting true facade behavior.
 */
describe('ACM-4R Stage 2 — CAP-2 multi-audience resolution (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm4r-${uuidv7()}`;
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
    const actual = audiences.get(employeeId) ?? new Set<Audience>();
    expect(actual.size).toBe(expected.length);
    expect([...actual].sort()).toEqual([...expected].sort());
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

    // ACM4R-MA-01 / ACM4R-MA-04: Marta is Alice's direct manager AND Alice's
    // assigned PP — both facts point at the same viewer.
    await createUser('Marta');
    await createUser('Alice');

    // ACM4R-MA-02: a single confirmed active user who is both viewer and
    // target of her own call.
    await createUser('SelfViewer');

    // ACM4R-MA-03: Daria has a live direct relationship to Zara and a live
    // people_partner relationship to Paula; Unrelated1 has neither.
    await createUser('Daria');
    await createUser('Zara');
    await createUser('Paula');
    await createUser('Unrelated1');

    // ACM4R-MA-05: FrViewer holds a real FR permission/policy/grant/attachment
    // but has no relationship to FrTarget.
    await createUser('FrViewer');
    await createUser('FrTarget');

    // ACM4R-MA-06: Mara6 is the bulk viewer over four targets covering every
    // audience class in one call; she also holds a real FR attachment to
    // prove separation within the same fixture.
    await createUser('Mara6');
    await createUser('Taylor6');
    await createUser('Reese6');
    await createUser('Carmen6');
    await createUser('Noah6');

    await prisma.relationship.createMany({
      data: [
        // MA-01 / MA-04
        {
          userId: ids.Alice,
          type: 'direct',
          reportsToUserId: ids.Marta,
        },
        {
          userId: ids.Alice,
          type: 'people_partner',
          reportsToUserId: ids.Marta,
        },
        // MA-03
        {
          userId: ids.Daria,
          type: 'direct',
          reportsToUserId: ids.Zara,
        },
        {
          userId: ids.Daria,
          type: 'people_partner',
          reportsToUserId: ids.Paula,
        },
        // MA-06
        {
          userId: ids.Taylor6,
          type: 'direct',
          reportsToUserId: ids.Mara6,
        },
        {
          userId: ids.Taylor6,
          type: 'people_partner',
          reportsToUserId: ids.Mara6,
        },
        {
          userId: ids.Reese6,
          type: 'direct',
          reportsToUserId: ids.Mara6,
        },
        {
          userId: ids.Carmen6,
          type: 'people_partner',
          reportsToUserId: ids.Mara6,
        },
      ],
    });

    // Real FR permission/policy/grant/attachment for MA-05 and MA-06 — the
    // same tables ACM-1 production created and bootstraps through, used
    // directly here since this fixture needs the grant on an arbitrary test
    // persona rather than the singleton root user.
    const permission = await prisma.permission.create({
      data: {
        key: `acm4r-fixture:${runId}`,
        description: 'ACM-4R fixture-only permission proving FR separation',
      },
      select: { id: true },
    });
    ids.FrPermission = permission.id;

    const policy = await prisma.policy.create({
      data: {
        operator: '==',
        targetType: null,
        targetRole: `acm4r-fixture-role-${runId}`,
        type: 'FR',
        managedBy: 'admin',
      },
      select: { id: true },
    });
    ids.FrPolicy = policy.id;

    await prisma.policyPermission.create({
      data: {
        policyId: policy.id,
        permissionId: permission.id,
        policyType: 'FR',
      },
    });

    await prisma.userPolicy.createMany({
      data: [
        { userId: ids.FrViewer, policyId: policy.id },
        { userId: ids.Mara6, policyId: policy.id },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      if (ids.FrPolicy) {
        await prisma.userPolicy.deleteMany({
          where: { policyId: ids.FrPolicy },
        });
        await prisma.policyPermission.deleteMany({
          where: { policyId: ids.FrPolicy },
        });
        await prisma.policy.delete({ where: { id: ids.FrPolicy } });
      }
      if (ids.FrPermission) {
        await prisma.permission.delete({ where: { id: ids.FrPermission } });
      }

      const fixtureIds = Object.values(ids).filter(
        (id, index, all) =>
          id !== ids.FrPolicy &&
          id !== ids.FrPermission &&
          all.indexOf(id) === index,
      );
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

  describe('ACM4R-MA-01 · Reporting and direct PP are retained for one target', () => {
    it('retains both Reporting and PP without either suppressing the other', async () => {
      const audiences = await facade.resolveAudiences(ids.Marta, [ids.Alice]);

      expect(audiences.size).toBe(1);
      expectAudienceEntry(audiences, ids.Alice, ['reporting', 'pp']);
    });
  });

  describe('ACM4R-MA-02 · Confirmed active Self is exclusive', () => {
    it('returns exactly Set{self} with no manager or Colleague audience merged in', async () => {
      const audiences = await facade.resolveAudiences(ids.SelfViewer, [
        ids.SelfViewer,
      ]);

      expect(audiences.size).toBe(1);
      expectAudienceEntry(audiences, ids.SelfViewer, ['self']);
    });
  });

  describe('ACM4R-MA-03 · Colleague is present only when no stronger audience applies', () => {
    it('Reporting suppresses the Colleague fallback', async () => {
      const audiences = await facade.resolveAudiences(ids.Zara, [ids.Daria]);

      expectAudienceEntry(audiences, ids.Daria, ['reporting']);
    });

    it('direct PP suppresses the Colleague fallback', async () => {
      const audiences = await facade.resolveAudiences(ids.Paula, [ids.Daria]);

      expectAudienceEntry(audiences, ids.Daria, ['pp']);
    });

    it('an unrelated active viewer receives the Colleague floor', async () => {
      const audiences = await facade.resolveAudiences(ids.Unrelated1, [
        ids.Daria,
      ]);

      expectAudienceEntry(audiences, ids.Daria, ['colleague']);
    });
  });

  describe('ACM4R-MA-04 · Repeated target input preserves one de-duplicated mixed result', () => {
    it('collapses a duplicate target id to one map entry with cardinality 2', async () => {
      const audiences = await facade.resolveAudiences(ids.Marta, [
        ids.Alice,
        ids.Alice,
      ]);

      expect(audiences.size).toBe(1);
      expect(audiences.get(ids.Alice)?.size).toBe(2);
      expectAudienceEntry(audiences, ids.Alice, ['reporting', 'pp']);
    });
  });

  describe('ACM4R-MA-05 · A functional permission never enters audience resolution', () => {
    it('resolves the Colleague floor and surfaces no permission/policy value', async () => {
      const audiences = await facade.resolveAudiences(ids.FrViewer, [
        ids.FrTarget,
      ]);

      expectAudienceEntry(audiences, ids.FrTarget, ['colleague']);
    });
  });

  describe('ACM4R-MA-06 · One PostgreSQL fixture covers every CAP-2 audience class', () => {
    it('preserves every applicable audience across one bulk facade call', async () => {
      const audiences = await facade.resolveAudiences(ids.Mara6, [
        ids.Taylor6,
        ids.Reese6,
        ids.Carmen6,
        ids.Noah6,
      ]);

      expect(audiences.size).toBe(4);
      expectAudienceEntry(audiences, ids.Taylor6, ['reporting', 'pp']);
      expectAudienceEntry(audiences, ids.Reese6, ['reporting']);
      expectAudienceEntry(audiences, ids.Carmen6, ['pp']);
      expectAudienceEntry(audiences, ids.Noah6, ['colleague']);
    });
  });
});
