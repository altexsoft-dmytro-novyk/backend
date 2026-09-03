import type { PrismaService } from '../../../src/prisma/prisma.service';
import { DepartureWorkerService } from '../../../src/user-management/infrastructure/departure-worker.service';
import type { TestApp } from '../access-control-adoption/fixtures';

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
 * The functional permission key for the *record a departure* capability.
 *
 * Settled by the FR-permission-matrix draft (2026-09-02) and
 * `spec-5-1-record-a-departure.md` (reconciled 2026-09-03) to the
 * `<domain>:<section>:<op>` shape — **`employee:departure:record`** — granted to
 * People Partner in the draft matrix. NOT seeded (`CANONICAL_PERMISSIONS` in
 * `access-control-bootstrap.ts` holds only `user-management:list` / `:create` /
 * `:deactivate`), so `isAllowed` is `false` for every actor until a suite grants
 * it via `fx.grantFunctionalRole(actorId, [RECORD_A_DEPARTURE_PERMISSION])`. The
 * gate is the no-target `isAllowed(actor, <this key>)` facade check — never an
 * `actor.position === 'HR Admin'` / role-name check (AD-4, DEC-UM-002).
 */
export const RECORD_A_DEPARTURE_PERMISSION = 'employee:departure:record';

/**
 * The write gate the re-parenting command (`um-dep-05`) additionally needs: it
 * reuses Epic 4's `application/` relationship-write services, whose own gate is
 * `org:relationships:write` (FR-permission-matrix §3; `epic-4/fixtures.ts`
 * `ORG_RELATIONSHIPS_WRITE_PERMISSION`). Not seeded — granted in-test.
 */
export const ORG_RELATIONSHIPS_WRITE_PERMISSION = 'org:relationships:write';

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

// ---------------------------------------------------------------------------
// AD-20 `Departure` aggregate — raw-SQL row probes (mirrors epic-3's
// `userEventsTableExists` / `queryUserEvents` and epic-4's
// `accessJournalTableExists` / `queryAccessJournalRows`).
//
// Story 5.1 hand-authors the `Departure` Prisma model + migration to
// `database-schema.md` §Departure (ratified). It does NOT exist on this branch
// (`schema.prisma` has no `Departure` model), so every probe below is
// `to_regclass`-guarded: a suite asserting "exactly one scheduled `Departure`
// row" reads as a clean red (expected 1, got 0) rather than throwing
// `relation "departures" does not exist`, and a suite asserting "zero rows
// after a 409 / 403" is a guardrail that stays green through Stage 3.
//
// Column names follow the repo convention (camelCase columns, `@@map`-ed table)
// and `database-schema.md` §Departure: `userId`, `effectiveDate`,
// `effectiveTimeZone`, `dueAt`, `reason`, `state`, `idempotencyKey`,
// `requestHash`, `attempts`, `appliedAt`, `createdAt`, `createdBy`.
// ---------------------------------------------------------------------------

/** `true` iff the `departures` relation exists — lets a test assert "model missing" crisply. */
export async function departureTableExists(
  prisma: PrismaService,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.departures') IS NOT NULL AS "exists"`,
  );
  return rows[0]?.exists === true;
}

export interface RawDeparture {
  id: string;
  userId: string;
  effectiveDate: Date;
  effectiveTimeZone: string | null;
  dueAt: Date | null;
  reason: string;
  state: string;
  idempotencyKey: string | null;
  attempts: number | null;
  appliedAt: Date | null;
  createdBy: string;
}

/**
 * Every `departures` row for `userId`, oldest first. Returns `[]` when the table
 * does not exist yet, so "exactly one `Departure` row" and "no `Departure` row
 * was written" are both assertable without a crash on the missing relation.
 */
export async function queryDepartureRows(
  prisma: PrismaService,
  userId: string,
): Promise<RawDeparture[]> {
  if (!(await departureTableExists(prisma))) {
    return [];
  }
  return prisma.$queryRawUnsafe<RawDeparture[]>(
    `SELECT id, "userId", "effectiveDate", "effectiveTimeZone", "dueAt", reason,
            state, "idempotencyKey", attempts, "appliedAt", "createdBy"
       FROM "departures"
      WHERE "userId" = $1
      ORDER BY "createdAt" ASC`,
    userId,
  );
}

/**
 * Delete every `departures` row owned by the run's users. Call FIRST in
 * `afterEach`, ahead of `RunFixtures.cleanup()` (relationships → policies /
 * permissions → users) and any department/journal cleanup, so teardown order is
 * departures → journal → relationships/policies → users (DEC-UM-010). Guarded on
 * table existence — a no-op today.
 */
export async function cleanupDepartures(
  prisma: PrismaService,
  userIds: Iterable<string>,
): Promise<void> {
  const ids = [...userIds];
  if (ids.length === 0) return;
  try {
    if (!(await departureTableExists(prisma))) return;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "departures" WHERE "userId" = ANY($1::text[])`,
      ids,
    );
  } catch (error) {
    console.warn('[epic-5] cleanupDepartures failed', error);
  }
}

// ---------------------------------------------------------------------------
// Story 5.2 (`um-dep-03/04/07/08`) — the DEC-UM-004 controllable-clock
// substitute + the `EmploymentStatus` interval row probe.
//
// There is NO fake clock and NO test-only worker HTTP endpoint
// (`testing-strategy.md` / `acm8-kc-04`). The "effective date has been reached"
// precondition is realised by back-dating `Departure.dueAt` against real
// PostgreSQL `now()`. Story 5.2's `DepartureWorkerService.processDueDepartures()`
// does not exist yet, so a suite that back-dates `dueAt` and then makes its
// assertions is committed-red on "nothing materialised" — exactly the shape the
// worker will turn green.
// ---------------------------------------------------------------------------

/**
 * Back-date a `Departure` row's `dueAt` so the row is "due" against PostgreSQL
 * `now()` with no wall-clock wait (DEC-UM-004 substitute). Story 5.1 only ever
 * writes a future `dueAt` (the record action rejects a non-future
 * `effectiveDate`), so a suite seeds the row through the real
 * `POST /users/:id/departures` and then calls this to make it claim-eligible.
 * Raw `UPDATE` — the Prisma client has no writable `dueAt` past-value path that
 * bypasses the domain rules.
 */
export async function backdateDepartureDueAt(
  prisma: PrismaService,
  departureId: string,
  when: Date = new Date(Date.now() - 60_000),
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "departures" SET "dueAt" = $1 WHERE id = $2`,
    when,
    departureId,
  );
}

/**
 * Drive one pass of the effective-departure worker directly — the DEC-UM-004 /
 * `um-dep-03` (decision 2) invocation seam: "the injectable service method
 * called directly from the E2E Nest testing module —
 * `DepartureWorkerService.processDueDepartures()` — not a non-prod test-only
 * HTTP endpoint". The `@Interval` polling loop stays off
 * (`DEPARTURE_WORKER_ENABLED=false`) so it never races this explicit call.
 *
 * Added at Stage 3: the committed-red stage-2 spec asserts the post-apply
 * outcome ("red-because-no-worker") but omitted the `processDueDepartures()`
 * call its own scenario docs mandate (`um-dep-03` lines 101-102 / 149;
 * `um-dep-04` lines 76 / 96). This is that call, nothing more.
 */
export const runDepartureWorker = (app: TestApp) =>
  app.app.get(DepartureWorkerService, { strict: false }).processDueDepartures();

export interface RawEmploymentStatusRow {
  id: string;
  status: string;
  validFrom: Date;
  validTo: Date | null;
  sourceDepartureId: string | null;
  departureReason: string | null;
}

/**
 * Every `employment_status` interval row for `userId`, oldest first. The
 * `EmploymentStatus` table exists (Story 1.1), so this is a real read: before
 * the Story 5.2 worker runs it returns just the seeded `active` row
 * (`validTo IS NULL`), and "the `active` row is closed AND a `dismissed` row
 * with `sourceDepartureId = <departureId>` exists" is committed-red.
 */
export async function queryEmploymentStatusRows(
  prisma: PrismaService,
  userId: string,
): Promise<RawEmploymentStatusRow[]> {
  return prisma.$queryRawUnsafe<RawEmploymentStatusRow[]>(
    `SELECT id, status, "validFrom", "validTo", "sourceDepartureId", "departureReason"
       FROM "employment_status"
      WHERE "userId" = $1
      ORDER BY "validFrom" ASC, "validTo" ASC NULLS LAST`,
    userId,
  );
}
