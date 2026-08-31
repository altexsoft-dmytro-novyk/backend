import { Test, TestingModule } from '@nestjs/testing';
import { uuidv7 } from 'uuidv7';
import { AccessControlModule } from '../../src/access-control/access-control.module';
import { AccessControlFacade } from '../../src/access-control/application/access-control.facade';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ACM-2 Stage 2 — CAP-4 live type-separated permission decisions.
 *
 * Translates only approved ACM2-IA-01..10 scenario contracts through the real
 * facade/module/Prisma/PostgreSQL path. There are no repository fakes,
 * provider overrides, or HTTP endpoints. EXPECTED RED: `isAllowed` does not
 * yet exist on AccessControlFacade; that missing public API is the subject.
 */
describe('ACM-2 Stage 2 — CAP-4 isAllowed (PostgreSQL)', () => {
  let moduleFixture: TestingModule;
  let facade: AccessControlFacade;
  let prisma: PrismaService;

  const runId = `acm2-${uuidv7()}`;
  const ids: Record<string, string> = {};
  const grantedKey = `acm2:granted-${runId}`;
  const otherKey = `acm2:other-${runId}`;
  const unknownKey = `acm2:unknown-${runId}`;
  const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

  const createUser = async (persona: string, isActive = true) => {
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
        createdBy: ids.Owner,
      },
      select: { id: true },
    });
    ids[persona] = user.id;
    return user.id;
  };

  const allow = (userId: string, key: string) => facade.isAllowed(userId, key);

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, AccessControlModule],
    }).compile();
    await moduleFixture.init();
    facade = moduleFixture.get(AccessControlFacade);
    prisma = moduleFixture.get(PrismaService);

    // `users.createdBy` is a restrictive self-FK, so a newly inserted fixture
    // user cannot name itself as creator. Reuse an already-migrated active user
    // and deliberately never delete that non-fixture row in teardown.
    const creator = await prisma.user.findFirst({
      where: { isActive: true },
      select: { id: true },
    });
    expect(creator).not.toBeNull();
    ids.Owner = creator!.id;
    await createUser('Granted');
    await createUser('Revoked');
    await createUser('RemovedPolicy');
    await createUser('Inactive', false);
    await createUser('ArAttached');
    await createUser('Nonmatching');

    const grantedPermission = await prisma.permission.create({
      data: { key: grantedKey, description: 'ACM-2 granted fixture key' },
    });
    const otherPermission = await prisma.permission.create({
      data: { key: otherKey, description: 'ACM-2 unlinked fixture key' },
    });
    ids.GrantedPermission = grantedPermission.id;
    ids.OtherPermission = otherPermission.id;

    const grantPolicy = await prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `acm2-granted-${runId}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    const nonmatchingPolicy = await prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `acm2-nonmatching-${runId}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    const removalPolicy = await prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `acm2-removal-${runId}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    const arPolicy = await prisma.policy.create({
      data: {
        operator: '==',
        targetType: 'project',
        targetId: uuidv7(),
        // The partial FR-only targetRole index permits this legal AR collision.
        targetRole: `acm2-granted-${runId}`,
        type: 'AR',
        managedBy: 'admin',
      },
    });
    ids.GrantPolicy = grantPolicy.id;
    ids.NonmatchingPolicy = nonmatchingPolicy.id;
    ids.ArPolicy = arPolicy.id;
    ids.RemovalPolicy = removalPolicy.id;

    await prisma.policyPermission.createMany({
      data: [
        { policyId: grantPolicy.id, permissionId: grantedPermission.id, policyType: 'FR' },
        // Exists in the catalog and on a policy, but not on Nonmatching's policy.
        { policyId: grantPolicy.id, permissionId: otherPermission.id, policyType: 'FR' },
        { policyId: removalPolicy.id, permissionId: grantedPermission.id, policyType: 'FR' },
      ],
    });
    await prisma.userPolicy.createMany({
      data: [
        { userId: ids.Granted, policyId: grantPolicy.id },
        { userId: ids.Revoked, policyId: grantPolicy.id },
        { userId: ids.RemovedPolicy, policyId: removalPolicy.id },
        { userId: ids.Inactive, policyId: grantPolicy.id },
        { userId: ids.ArAttached, policyId: arPolicy.id },
        { userId: ids.Nonmatching, policyId: nonmatchingPolicy.id },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.userPolicy.deleteMany({ where: { policyId: { in: [ids.GrantPolicy, ids.NonmatchingPolicy, ids.ArPolicy, ids.RemovalPolicy].filter(Boolean) } } });
      await prisma.policyPermission.deleteMany({ where: { policyId: { in: [ids.GrantPolicy, ids.RemovalPolicy].filter(Boolean) } } });
      await prisma.policy.deleteMany({ where: { id: { in: [ids.GrantPolicy, ids.NonmatchingPolicy, ids.ArPolicy, ids.RemovalPolicy].filter(Boolean) } } });
      await prisma.permission.deleteMany({ where: { id: { in: [ids.GrantedPermission, ids.OtherPermission].filter(Boolean) } } });
      await prisma.user.deleteMany({ where: { id: { in: Object.values(ids).filter((id) => id !== ids.Owner && ![ids.GrantPolicy, ids.NonmatchingPolicy, ids.ArPolicy, ids.GrantedPermission, ids.OtherPermission].includes(id)) } } });
    }
    await moduleFixture?.close();
  });

  // ACM2-IA-01
  it('allows a live active FR grant for the exact key', async () => {
    await expect(allow(ids.Granted, grantedKey)).resolves.toBe(true);
  });

  // ACM2-IA-02
  it('observes a deleted UserPolicies attachment on the next call', async () => {
    await expect(allow(ids.Revoked, grantedKey)).resolves.toBe(true);
    await prisma.userPolicy.delete({ where: { userId_policyId: { userId: ids.Revoked, policyId: ids.GrantPolicy } } });
    await expect(allow(ids.Revoked, grantedKey)).resolves.toBe(false);

    await expect(allow(ids.RemovedPolicy, grantedKey)).resolves.toBe(true);
    await prisma.userPolicy.delete({ where: { userId_policyId: { userId: ids.RemovedPolicy, policyId: ids.RemovalPolicy } } });
    await prisma.policyPermission.deleteMany({ where: { policyId: ids.RemovalPolicy } });
    await prisma.policy.delete({ where: { id: ids.RemovalPolicy } });
    await expect(allow(ids.RemovedPolicy, grantedKey)).resolves.toBe(false);
  });

  // ACM2-IA-03
  it('denies an inactive user despite a valid FR attachment and grant', async () => {
    await expect(allow(ids.Inactive, grantedKey)).resolves.toBe(false);
  });

  // ACM2-IA-04
  it('denies a nonexistent user id as an ordinary false result', async () => {
    await expect(allow(uuidv7(), grantedKey)).resolves.toBe(false);
  });

  // ACM2-IA-05
  it('denies an unknown catalog key', async () => {
    await expect(allow(ids.Granted, unknownKey)).resolves.toBe(false);
  });

  // ACM2-IA-06
  it('denies a case-only variant of a granted key', async () => {
    await expect(allow(ids.Granted, grantedKey.toUpperCase())).resolves.toBe(false);
  });

  // ACM2-IA-10
  it('denies an empty key without asserting an invented short-circuit', async () => {
    await expect(allow(ids.Granted, '')).resolves.toBe(false);
  });

  // ACM2-IA-07
  it('does not treat an attached AR cross-type collision as an FR grant', async () => {
    await expect(allow(ids.ArAttached, grantedKey)).resolves.toBe(false);
  });

  // ACM2-IA-08
  it('denies a catalog permission that is not granted through an attached policy', async () => {
    await expect(allow(ids.Nonmatching, otherKey)).resolves.toBe(false);
  });

  // ACM2-IA-09 — a real PostgreSQL query failure, restored in finally.
  it('propagates a database query failure instead of returning false', async () => {
    const hiddenName = `Permissions_acm2_hidden_${uuidv7().replaceAll('-', '')}`;
    await prisma.$executeRawUnsafe(`ALTER TABLE "Permissions" RENAME TO "${hiddenName}"`);
    try {
      await expect(allow(ids.Granted, grantedKey)).rejects.toBeDefined();
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${hiddenName}" RENAME TO "Permissions"`);
    }
  });
});
