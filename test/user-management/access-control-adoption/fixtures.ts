import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import type { User } from '../../../src/generated/prisma/client';

// Shared fixtures for the Epic 0 — Access Control Adoption Stage-2 E2E suites
// (UMAC-01..09). DEC-UM-010 gate isolation: one worker, a collision-proof UUID
// namespace per run, each test deletes only the rows it created (Relationship
// before User for FK order; UserPolicy / PolicyPermission / Policy / Permission
// too, where the test created them). Every teardown step is wrapped so one
// failure does not skip the rest.
//
// AD-3 consumer rule: the suites boot the real `AppModule` (real
// UserManagementModule + real @Global AccessControlModule), real Prisma against
// migrated PostgreSQL, and NO `overrideProvider` on the database, repositories,
// router, session resolver, or the facade. The interim *session* resolver stays
// (Epic 2 retires it) — fixtures use its `Bearer <token:<uuid>>` convention.

export const S1_CARD_FIELDS = [
  'id',
  'firstName',
  'lastName',
  'photo',
  'position',
  'country',
  'city',
  'workEmail',
  'workPhone',
  'birthDay',
  'birthMonth',
  'companyJoinDate',
] as const;

// Non-S1 technical fields the S1-card DTO (Story 0.1) must DROP from the body.
// Under the current interim adapter `toUserResponse` spreads the whole `User`
// row, so every one of these is still present — which is what makes the
// UMAC-01..04 body assertions committed-red.
export const NON_S1_FIELDS = [
  'ttId',
  'isActive',
  'customFields',
  'createdAt',
  'createdBy',
] as const;

// The three no-target permission keys ACM-1 seeds and grants to the one
// `hr-admin` FR policy (see
// services/backend/src/access-control/infrastructure/bootstrap/access-control-bootstrap.ts
// CANONICAL_PERMISSIONS). These are exactly `user-management:list` / `:create` /
// `:deactivate` — the keys `GET /users`, `POST /users`, `DELETE /users/:id`
// check via the non-target `isAllowed` path.
export const CANONICAL_UM_PERMISSION_KEYS = [
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
] as const;

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  moduleFixture: TestingModule;
}

export async function bootstrapTestApp(): Promise<TestApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  // Bootstrap config is not inherited by the test app (nest-e2e.md) — re-enable
  // the pipe exactly as main.ts does so POST/PATCH body whitelisting matches
  // production.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma, moduleFixture };
}

export const bearer = (userId: string): string => `Bearer <token:${userId}>`;

export interface UserOverrides {
  firstName?: string;
  lastName?: string;
  photo?: string | null;
  position?: string;
  country?: string;
  city?: string;
  workPhone?: string | null;
  birthDay?: number | null;
  birthMonth?: number | null;
  companyJoinDate?: string;
  isActive?: boolean;
  ttId?: string;
}

/**
 * Tracks every row a suite creates so teardown removes only what it owns
 * (DEC-UM-010). `permissionIds` holds ONLY permission rows this run created —
 * a pre-existing canonical `user-management:*` row (seeded/bootstrapped) is
 * reused and never deleted.
 */
export class RunFixtures {
  readonly runId = `umac-${uuidv7()}`;
  readonly userIds = new Set<string>();
  readonly policyIds = new Set<string>();
  readonly permissionIds = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  emailFor(persona: string): string {
    return `${this.runId}-${persona}@company.example`;
  }

  /**
   * A real, active-by-default `User` row with every S1 field populated so the
   * card assertions have concrete values to match. `createdBy` self-references
   * the generated id (the first-row pattern used by seed.ts / acm0), so no
   * separate fixture-owner row is needed.
   */
  async user(persona: string, overrides: UserOverrides = {}): Promise<User> {
    const id = uuidv7();
    const created = await this.prisma.user.create({
      data: {
        id,
        firstName: overrides.firstName ?? 'Fixture',
        lastName: overrides.lastName ?? `Person-${persona}`,
        photo:
          overrides.photo === undefined
            ? `https://photos.example/${this.runId}/${persona}.jpg`
            : overrides.photo,
        position: overrides.position ?? 'Engineer',
        country: overrides.country ?? 'PL',
        city: overrides.city ?? 'Krakow',
        workEmail: this.emailFor(persona),
        workPhone:
          overrides.workPhone === undefined
            ? '+48 100 200 300'
            : overrides.workPhone,
        birthDay: overrides.birthDay === undefined ? 10 : overrides.birthDay,
        birthMonth:
          overrides.birthMonth === undefined ? 5 : overrides.birthMonth,
        companyJoinDate: new Date(overrides.companyJoinDate ?? '2020-01-01'),
        isActive: overrides.isActive ?? true,
        createdBy: id,
        ...(overrides.ttId ? { ttId: overrides.ttId } : {}),
      },
    });
    this.userIds.add(created.id);
    return created;
  }

  /**
   * A real reporting edge: `subordinate` reports to `manager`.
   * `prisma-relationship-graph.adapter.ts` walks upward from `userId` through
   * `type='direct'` rows and grants `reporting` to whoever sits at
   * `reportsToUserId` — so `{ userId: subordinate, reportsToUserId: manager }`
   * makes `manager` resolve `reporting` (S1 `write`) over `subordinate`.
   * Verified against acm5-section-access.e2e-spec.ts (ReportingViewer /
   * ReportingTarget) and acm3-inactive-identity.e2e-spec.ts.
   */
  async reportsTo(subordinateId: string, managerId: string): Promise<void> {
    await this.prisma.relationship.create({
      data: {
        userId: subordinateId,
        type: 'direct',
        reportsToUserId: managerId,
      },
    });
  }

  /**
   * A real directly-assigned People Partner edge: `pp` is `employee`'s PP.
   * The PP branch of the graph adapter matches `type='people_partner'` where
   * `reportsToUserId = viewer` — so `pp` resolves the `pp` audience (S1
   * `write`) over `employee`.
   */
  async peoplePartnerOf(employeeId: string, ppId: string): Promise<void> {
    await this.prisma.relationship.create({
      data: {
        userId: employeeId,
        type: 'people_partner',
        reportsToUserId: ppId,
      },
    });
  }

  /**
   * A real functional-role grant chain: active User -> UserPolicy -> FR Policy
   * -> FR PolicyPermission -> Permission(key). Mirrors the ACM-1 shape
   * (acm2-is-allowed.e2e-spec.ts). `AccessControlFacade.isAllowed` only checks
   * that such a chain EXISTS for the exact key — it never reads `targetRole`,
   * `operator`, or `User.position`.
   *
   * Canonical `user-management:*` permission rows are reused when already
   * present (seeded/bootstrapped) and are never torn down; only rows this run
   * created are tracked for deletion.
   */
  async grantFunctionalRole(
    userId: string,
    keys: readonly string[] = CANONICAL_UM_PERMISSION_KEYS,
  ): Promise<{ policyId: string; permissionIds: string[] }> {
    const permissionIds: string[] = [];
    for (const key of keys) {
      const existing = await this.prisma.permission.findUnique({
        where: { key },
      });
      if (existing) {
        permissionIds.push(existing.id);
        continue;
      }
      const created = await this.prisma.permission.create({
        data: { key, description: `${key} (UMAC fixture)` },
      });
      this.permissionIds.add(created.id);
      permissionIds.push(created.id);
    }

    const policy = await this.prisma.policy.create({
      data: {
        operator: '==',
        targetRole: `${this.runId}-${userId.slice(0, 8)}`,
        type: 'FR',
        managedBy: 'admin',
      },
    });
    this.policyIds.add(policy.id);

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

    return { policyId: policy.id, permissionIds };
  }

  /** Wrapped teardown — one failure never skips the rest (DEC-UM-010). */
  async cleanup(): Promise<void> {
    const userIds = [...this.userIds];
    const policyIds = [...this.policyIds];
    const permissionIds = [...this.permissionIds];

    const steps: Array<() => Promise<unknown>> = [
      () =>
        this.prisma.relationship.deleteMany({
          where: {
            OR: [
              { userId: { in: userIds } },
              { reportsToUserId: { in: userIds } },
            ],
          },
        }),
      () =>
        this.prisma.userPolicy.deleteMany({
          where: { policyId: { in: policyIds } },
        }),
      () =>
        this.prisma.policyPermission.deleteMany({
          where: { policyId: { in: policyIds } },
        }),
      () => this.prisma.policy.deleteMany({ where: { id: { in: policyIds } } }),
      () =>
        this.prisma.permission.deleteMany({
          where: { id: { in: permissionIds } },
        }),
      () => this.prisma.user.deleteMany({ where: { id: { in: userIds } } }),
      // Belt-and-suspenders: sweep anything keyed by the run namespace that a
      // failed step above might have left behind.
      () =>
        this.prisma.user.deleteMany({
          where: { workEmail: { contains: this.runId } },
        }),
    ];

    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn(`[${this.runId}] teardown step failed`, error);
      }
    }
  }
}

/** Assert the response body is EXACTLY the S1 identity card and nothing else. */
export function expectExactS1Card(
  body: unknown,
  expected: Record<string, unknown>,
): void {
  expect(body).toEqual(expected);
  for (const field of NON_S1_FIELDS) {
    expect(body as Record<string, unknown>).not.toHaveProperty(field);
  }
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(
    [...S1_CARD_FIELDS].sort(),
  );
}

/** The exact S1 card a seeded `User` row must project to on `GET /users/:id`. */
export function s1CardOf(user: User): Record<string, unknown> {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    photo: user.photo,
    position: user.position,
    country: user.country,
    city: user.city,
    workEmail: user.workEmail,
    workPhone: user.workPhone,
    birthDay: user.birthDay,
    birthMonth: user.birthMonth,
    // `companyJoinDate` is `@db.Date`; `toUserResponse` already serializes it
    // to the date-only string.
    companyJoinDate: user.companyJoinDate.toISOString().slice(0, 10),
  };
}

/**
 * Assert a denial body leaks nothing about the target — no field names, no
 * seeded values, no confirmation the target exists.
 */
export function expectLeakFreeBody(body: unknown, target?: User): void {
  const record = (body ?? {}) as Record<string, unknown>;
  for (const field of [...S1_CARD_FIELDS, ...NON_S1_FIELDS]) {
    expect(record).not.toHaveProperty(field);
  }
  if (target) {
    const serialized = JSON.stringify(body ?? {});
    expect(serialized).not.toContain(target.workEmail);
    expect(serialized).not.toContain(target.lastName);
    expect(serialized).not.toContain(target.id);
  }
}
