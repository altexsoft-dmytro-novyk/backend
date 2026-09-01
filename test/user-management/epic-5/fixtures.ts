import type { PrismaService } from '../../../src/prisma/prisma.service';

// Shared helpers for the Epic 5 — Employment Lifecycle / Departure Stage-2 E2E
// suites (`um-dep-01..04`).
//
// The app-booting parts (`bootstrapTestApp`, `RunFixtures`, `bearer`) are the
// Epic 0 adoption fixtures, reused verbatim — AD-3-clean boot (real
// `AppModule`, real Prisma / migrated PostgreSQL, NO provider overrides), real
// `User` + `Relationship` inserts (`fx.user()`, `fx.reportsTo()`,
// `fx.peoplePartnerOf()`, `fx.grantFunctionalRole()`), run-namespaced emails,
// and wrapped scoped teardown (relationships → policies/permissions → users,
// DEC-UM-010). This file adds only what Epic 5 needs on top: the inferred
// `record a departure` permission key, an unrelated-permission key for the
// permission negative, and `to_regclass` readers for the CC-06-owned
// `Departure` / `EmploymentStatus` tables that stay CLEAN assertion failures
// (never a crash) while CC-06 is unapproved and the schema is absent.
export {
  bootstrapTestApp,
  bearer,
  RunFixtures,
  type TestApp,
  type UserOverrides,
} from '../access-control-adoption/fixtures';

/**
 * INFERRED permission key for the *record a departure* capability.
 *
 * `api-conventions.md` ("Departure command and status (AD-20)") and
 * `spec-5-1-record-a-departure.md` name the gate only in prose — "The command
 * requires the **`record a departure`** permission (through the facade — no
 * role-name check)" — and no catalog entry exists (`CANONICAL_PERMISSIONS` in
 * `access-control-bootstrap.ts` holds only `user-management:list` / `:create` /
 * `:deactivate`; Epic 4 separately infers
 * `user-management:change-organisational-relationships`). This is a plausible
 * `context:action` string in the same namespace, isolated to ONE constant so a
 * single edit realigns every Epic 5 test once the real key is registered. The
 * gate is the no-target `isAllowed(actor, <this key>)` facade check — never an
 * `actor.position === 'HR Admin'` / role-name check (AD-4, DEC-UM-002).
 */
export const RECORD_A_DEPARTURE_PERMISSION =
  'user-management:record-a-departure';

/**
 * An unrelated permission for the permission negative: the denied actor holds a
 * functional role, just not *this* one — so a `403` cannot be passing for "no
 * session / no role at all".
 */
export const UNRELATED_PERMISSION = 'user-management:list';

/** The canonical list permission — needed by `GET /users` (`@RequireFeature`). */
export const LIST_USERS_PERMISSION = 'user-management:list';

const DEPARTURE_TABLE_CANDIDATES = [
  'departures',
  'departure',
  'Departure',
  'user_departures',
] as const;

const EMPLOYMENT_STATUS_TABLE_CANDIDATES = [
  'employment_status',
  'employment_statuses',
  'employment_intervals',
  'employment_status_intervals',
  'EmploymentStatus',
] as const;

async function firstExistingTable(
  prisma: PrismaService,
  candidates: readonly string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      candidate,
    );
    if (rows[0]?.exists === true) {
      return candidate;
    }
  }
  return null;
}

/**
 * Name of the AD-20 `Departure` aggregate table if one exists, else `null`.
 * Uses `to_regclass`, so a missing table is a clean `null` — never a thrown
 * "relation does not exist".
 *
 * CC-06 owns the `Departure` state machine (`scheduled|processing|retry_wait|
 * applied`), the `effectiveDate`/`effectiveTimeZone`/`dueAt` columns, the
 * fencing token, and the idempotency-hash column. No such table exists on
 * `dn-um-2` today (`schema.prisma` has models `User`, `Relationship`,
 * `Project`, `Policy`, `Permission`, `PolicyPermission`, `UserPolicy`,
 * `AccessControlBootstrap` — no `Departure`), so every
 * `expect(await departureTable(prisma)).not.toBeNull()` is
 * committed-red-on-missing-model and stands in for "a real
 * `departures`-row-count assertion once CC-06 lands".
 */
export function departureTable(prisma: PrismaService): Promise<string | null> {
  return firstExistingTable(prisma, DEPARTURE_TABLE_CANDIDATES);
}

/**
 * Name of the AD-16 / AD-20 time-bounded `EmploymentStatus` (`active` /
 * `dismissed`) interval table if one exists, else `null`. Absent on `dn-um-2`
 * today — `User.isActive` is the internal row-retention flag and is explicitly
 * NOT employment status (AD-16). Red-because-model-missing.
 */
export function employmentStatusTable(
  prisma: PrismaService,
): Promise<string | null> {
  return firstExistingTable(prisma, EMPLOYMENT_STATUS_TABLE_CANDIDATES);
}
