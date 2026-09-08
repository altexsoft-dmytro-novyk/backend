import { createHash } from 'node:crypto';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Provider-side harness for the consumer-driven contract suite.
 *
 * Unlike the e2e fixtures, this one boots the app the way `src/main.ts` does —
 * global prefix `api` plus URI versioning. That is deliberate and it is half the
 * value of this suite: every existing e2e spec calls `/users`, while production
 * serves `/api/v1/users`, so the routing configuration itself has never been
 * exercised by a test. The recorded consumer contract addresses the real paths,
 * so verification fails if that configuration drifts.
 */
export interface ProviderApp {
  app: INestApplication;
  prisma: PrismaService;
  moduleFixture: TestingModule;
  baseUrl: string;
}

export async function startProviderApp(): Promise<ProviderApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.init();
  // Port 0 — the OS picks a free one, so a stale process never wedges the run.
  await app.listen(0);

  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, prisma: app.get(PrismaService), moduleFixture, baseUrl: url };
}

/**
 * The ids the consumer pinned into the pact. A contract addresses concrete
 * resources, so the provider has to own rows at exactly these ids rather than
 * generate its own.
 */
export const IDS = {
  viewer: '01920000-0000-7000-8000-0000000000v1'.replace('v', 'f'),
  subject: '01920000-0000-7000-8000-000000000001',
  target: '01920000-0000-7000-8000-000000000002',
  currentPeoplePartner: '01920000-0000-7000-8000-000000000003',
  relationship: '01920000-0000-7000-8000-0000000000a1',
  event: '01920000-0000-7000-8000-0000000000e3',
  departure: '01920000-0000-7000-8000-0000000000d1',
} as const;

const OWNED_USER_IDS = [
  IDS.viewer,
  IDS.subject,
  IDS.target,
  IDS.currentPeoplePartner,
];

/**
 * The permission keys the frontend's routes gate on. Only the three
 * `user-management:*` keys are seeded by `access-control-bootstrap.ts`; the
 * other three exist solely as string literals in the action files, so no
 * deployed user holds them. The contract states grant them explicitly, which is
 * what makes that gap visible instead of silent.
 */
export const FEATURE_KEYS = {
  list: 'user-management:list',
  create: 'user-management:create',
  orgWrite: 'org:relationships:write',
  timelineWrite: 'profile:timeline:write',
  departure: 'employee:departure:record',
} as const;

/** The position only contract-owned directory rows carry. */
export const CONTRACT_POSITION = 'Contract Engineer';

export class ContractWorld {
  /** Set by each state handler; the request filter signs requests as this user. */
  viewerId: string = IDS.viewer;

  private readonly createdPolicyIds = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return the pinned rows to a known-empty baseline before each interaction.
   * Deletion is by pinned id only — a contract run must never touch a row it
   * did not create, and these suites share a database with the e2e ones.
   */
  async reset(): Promise<void> {
    await this.prisma.departure.deleteMany({
      where: { userId: { in: OWNED_USER_IDS } },
    });
    await this.prisma.userEvent.deleteMany({
      where: { userId: { in: OWNED_USER_IDS } },
    });
    await this.prisma.accessJournal.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: OWNED_USER_IDS } },
          { subjectUserId: { in: OWNED_USER_IDS } },
        ],
      },
    });
    await this.prisma.relationship.deleteMany({
      where: {
        OR: [
          { userId: { in: OWNED_USER_IDS } },
          { reportsToUserId: { in: OWNED_USER_IDS } },
        ],
      },
    });
    await this.prisma.userPolicy.deleteMany({
      where: { userId: { in: OWNED_USER_IDS } },
    });
    await this.prisma.magicLinkToken.deleteMany({
      where: { userId: { in: OWNED_USER_IDS } },
    });
    this.viewerId = IDS.viewer;
  }

  /** Idempotent: the row survives across interactions, its state does not. */
  async user(
    id: string,
    persona: string,
    position = 'Engineer',
  ): Promise<void> {
    await this.prisma.user.upsert({
      where: { id },
      update: { isActive: true, position },
      create: {
        id,
        firstName: persona,
        lastName: 'Contract',
        photo: `https://photos.example/${persona}.jpg`,
        position,
        country: 'PL',
        city: 'Krakow',
        workEmail: `pact-${persona}@company.example`,
        workPhone: '+48 100 200 300',
        birthDay: 10,
        birthMonth: 5,
        companyJoinDate: new Date('2020-01-01'),
        isActive: true,
        createdBy: id,
      },
    });
  }

  /** Viewer, subject and target exist and are active. */
  async cast(): Promise<void> {
    await this.user(IDS.viewer, 'viewer', 'HR Admin');
    await this.user(IDS.subject, 'subject', CONTRACT_POSITION);
    await this.user(IDS.target, 'target', CONTRACT_POSITION);
    await this.user(IDS.currentPeoplePartner, 'current-pp', CONTRACT_POSITION);
  }

  /** A live FR grant chain for `keys` — the only thing `isAllowed` accepts. */
  async grant(userId: string, keys: readonly string[]): Promise<void> {
    const permissionIds: string[] = [];
    for (const key of keys) {
      const permission = await this.prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key, description: `${key} (contract fixture)` },
      });
      permissionIds.push(permission.id);
    }

    const policy = await this.prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `pact-${userId.slice(0, 8)}-${Date.now()}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    this.createdPolicyIds.add(policy.id);

    await this.prisma.policyPermission.createMany({
      data: permissionIds.map((permissionId) => ({
        policyId: policy.id,
        permissionId,
        policyType: 'FR',
      })),
    });
    await this.prisma.userPolicy.create({
      data: { userId, policyId: policy.id },
    });
  }

  /** `subordinate` reports to `manager`, which grants `manager` the reporting audience. */
  async reportsTo(
    subordinateId: string,
    managerId: string,
    relationshipId?: string,
  ): Promise<void> {
    await this.prisma.relationship.create({
      data: {
        ...(relationshipId ? { id: relationshipId } : {}),
        userId: subordinateId,
        type: 'direct',
        reportsToUserId: managerId,
      },
    });
  }

  async peoplePartnerOf(
    employeeId: string,
    ppId: string,
    relationshipId?: string,
  ): Promise<void> {
    await this.prisma.relationship.create({
      data: {
        ...(relationshipId ? { id: relationshipId } : {}),
        userId: employeeId,
        type: 'people_partner',
        reportsToUserId: ppId,
      },
    });
  }

  async manualEvent(userId: string, id: string): Promise<void> {
    await this.prisma.userEvent.create({
      data: {
        id,
        userId,
        type: 'promotion',
        eventDate: new Date('2025-06-01'),
        details: {},
        source: 'manual',
        createdBy: this.viewerId,
      },
    });
  }

  async departure(
    userId: string,
    id: string,
    overrides: {
      state?: 'scheduled' | 'processing' | 'retry_wait' | 'applied';
      attempts?: number;
      lastError?: string;
    } = {},
  ): Promise<void> {
    await this.prisma.departure.create({
      data: {
        id,
        userId,
        effectiveDate: new Date('2026-12-31'),
        effectiveTimeZone: 'Europe/Warsaw',
        dueAt: new Date('2026-12-30T23:00:00.000Z'),
        reason: 'Resignation',
        state: overrides.state ?? 'scheduled',
        idempotencyKey: '9f1c4d2e-6b7a-4c3d-8e9f-0a1b2c3d4e5f',
        requestHash: 'contract-fixture',
        attempts: overrides.attempts ?? 0,
        lastError: overrides.lastError ?? null,
        createdBy: this.viewerId,
      },
    });
  }

  /**
   * An unconsumed, unexpired magic-link token for `userId`. Only the SHA-256 of
   * the raw token is stored, so the raw value is returned for the contract's
   * consume request to carry.
   */
  async magicLinkToken(userId: string, rawToken: string): Promise<void> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.prisma.magicLinkToken.deleteMany({ where: { userId } });
    await this.prisma.magicLinkToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
  }

  /** Full teardown. Policies created by this run go too. */
  async cleanup(): Promise<void> {
    await this.reset();
    await this.prisma.policyPermission.deleteMany({
      where: { policyId: { in: [...this.createdPolicyIds] } },
    });
    await this.prisma.policy.deleteMany({
      where: { id: { in: [...this.createdPolicyIds] } },
    });
    await this.prisma.user.deleteMany({
      where: { id: { in: OWNED_USER_IDS } },
    });
  }
}
