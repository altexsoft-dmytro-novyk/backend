// UM-owned port for the Epic 5 Story 5.1 `Departure` aggregate
// (`POST /users/:id/departures`, `GET /users/:id/departures/:departureId`,
// `POST /users/:id/departure-reparenting`). AD-20 / database-schema.md §Departure.
//
// The single implementation (`infrastructure/departure.repository.ts`) is the
// only place `departures` rows are written by Story 5.1, and the only place the
// re-parent transaction reassigns the platform-owned blockers + writes their
// `AccessJournal` rows. `domain/services/` hold this token; `application/`
// reaches it only through `DepartureService`.

/** One `direct` `Relationship` where the departing person is the `reportsToUserId`. */
export interface DirectReportBlocker {
  relationshipId: string;
  reportUserId: string;
  reportName: string;
}

/** The AR `Policies` row (`targetType: 'department'`, `targetRole: 'unit-manager'`)
 *  linked to the departing person via `UserPolicies`. */
export interface DepartmentManagerBlocker {
  policyId: string;
  departmentId: string;
  departmentName: string;
}

/** One `people_partner` `Relationship` where the departing person is the `reportsToUserId`. */
export interface PeoplePartnerBlocker {
  relationshipId: string;
  partneredUserId: string;
  partneredName: string;
}

/** The still-current platform-owned responsibilities that block a departure.
 *  `external_pm_dm` (timetracker-derived) is deliberately absent — no sync seam
 *  exists, and it is never a platform row. */
export interface PlatformBlockerSet {
  directReports: DirectReportBlocker[];
  departmentManager: DepartmentManagerBlocker | null;
  peoplePartnerAssignments: PeoplePartnerBlocker[];
  /** The departing person's own current `direct` manager id — the one-click
   *  re-parent default — or `null` when they have no manager. */
  ownDirectManagerId: string | null;
}

/** The subset of `departures` columns any Story 5.1 read projects from. Worker
 *  internals (`leaseToken`, `nextAttemptAt`, …) are never surfaced. */
export interface DepartureRecord {
  id: string;
  userId: string;
  state: string;
  effectiveDate: Date;
  effectiveTimeZone: string;
  dueAt: Date;
  reason: string;
  requestHash: string;
  attempts: number;
  lastError: string | null;
  appliedAt: Date | null;
  createdAt: Date;
}

export interface CreateDepartureInput {
  userId: string;
  /** ISO effective date (`YYYY-MM-DD`). */
  effectiveDate: string;
  effectiveTimeZone: string;
  dueAt: Date;
  /** Already normalized (trim + internal-whitespace collapse). */
  reason: string;
  /** The raw `Idempotency-Key` header value — the adapter coerces it to the
   *  `uuid` column. */
  idempotencyKey: string;
  requestHash: string;
  createdBy: string;
}

export type CreateDepartureResult =
  | { outcome: 'created'; record: DepartureRecord }
  /** A concurrent insert won the `idempotencyKey` race with the SAME payload —
   *  treat as a replay of the original `201`. */
  | { outcome: 'idempotency_replay'; record: DepartureRecord }
  /** The `idempotencyKey` already exists with a DIFFERENT `requestHash`. */
  | { outcome: 'idempotency_mismatch' }
  /** A non-applied `Departure` already exists for the user under another key
   *  (the partial `UNIQUE`). */
  | { outcome: 'already_scheduled' };

export interface ReparentCommand {
  userId: string;
  targetId: string;
  actorId: string;
  /** The opaque digest the caller echoed from the blocker `409`. */
  expectedBlockerVersion: string;
}

export interface ReparentCounts {
  directReports: number;
  departmentManager: boolean;
  peoplePartnerAssignments: number;
}

export type ReparentResult =
  | { outcome: 'reassigned'; counts: ReparentCounts }
  /** The recomputed digest no longer matches `expectedBlockerVersion` — nothing
   *  was reassigned, the whole transaction rolled back. */
  | { outcome: 'stale' };

export interface DepartureRepositoryPort {
  /** The platform-owned responsibilities the person currently holds, plus their
   *  own manager id for the re-parent default. */
  loadPlatformBlockers(userId: string): Promise<PlatformBlockerSet>;

  /** Look up an existing `Departure` by the raw `Idempotency-Key` header value
   *  (coerced to the `uuid` column). */
  findByIdempotencyKey(rawKey: string): Promise<DepartureRecord | null>;

  /** The one non-applied `Departure` for the user, if any. */
  findNonAppliedByUser(userId: string): Promise<DepartureRecord | null>;

  /** Scoped read for `GET /users/:id/departures/:departureId` — `null` when the
   *  id is unknown or belongs to another user. */
  findByIdForUser(
    userId: string,
    departureId: string,
  ): Promise<DepartureRecord | null>;

  /** Insert a `scheduled` `Departure`. Maps the unique-constraint races to the
   *  `CreateDepartureResult` outcomes — the caller never sees a Prisma error. */
  create(input: CreateDepartureInput): Promise<CreateDepartureResult>;

  /** The Epic 4 post-schedule guard's query: does the user hold a non-applied
   *  `Departure`? */
  hasNonAppliedDeparture(userId: string): Promise<boolean>;

  /** In ONE transaction: recompute the blocker digest over the still-current
   *  platform set; on mismatch → `stale` (roll back); otherwise reassign every
   *  platform blocker to `targetId` and write one `AccessJournal` row per kind
   *  (`manager` / `department_manager` / `people_partner`). Writes NO `departures`
   *  row. */
  reparentPlatformBlockers(command: ReparentCommand): Promise<ReparentResult>;
}

export const DEPARTURE_REPOSITORY_PORT = Symbol('DEPARTURE_REPOSITORY_PORT');
