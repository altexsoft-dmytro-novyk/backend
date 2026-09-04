import type {
  DepartmentMembership,
  Relationship,
} from '../../../generated/prisma/client';

// UM-owned port for the Epic 4 organisational-relationship WRITE paths
// (`POST /users/:id/relationships`, `DELETE /users/:id/relationships/:relationshipId`).
// Story 4.1 covers the `direct` (reports-to) edge only.
//
// The single implementation (`infrastructure/org-relationship.repository.ts`) is
// the ONLY place these two facts are written: each mutation and its one
// `AccessJournal` row (`kind: 'manager'`) commit in ONE `prisma.$transaction`
// (AD-11 explicit synchronous call — no event bus). `domain/services/` hold this
// token; `application/actions/` reach it only through `OrgRelationshipService`.

/** The edge snapshot persisted into `AccessJournal.before` / `.after` — a
 *  complete record of the `direct` edge, since `Relationship` DELETE is a hard
 *  delete and the row survives nowhere else (database-schema.md §AccessJournal). */
export interface ManagerEdgeSnapshot {
  relationshipId: string;
  userId: string;
  type: 'direct';
  reportsToUserId: string;
}

export interface AssignManagerCommand {
  /** The employee whose manager is being set (`:id`). */
  subjectId: string;
  /** The new manager (`targetId`). */
  targetId: string;
  /** The authenticated principal performing the change. */
  actorId: string;
}

export interface RevokeManagerCommand {
  subjectId: string;
  /** The `direct` `Relationship` row id from the path (`:relationshipId`). */
  relationshipId: string;
  actorId: string;
}

// --- Story 4.2 — the fixed-cardinality `people_partner` edge -----------------

/** The `people_partner` edge snapshot persisted into `AccessJournal.before` /
 *  `.after` — the only surviving record of a hard-deleted edge. */
export interface PeoplePartnerEdgeSnapshot {
  relationshipId: string;
  userId: string;
  type: 'people_partner';
  reportsToUserId: string;
}

export interface ChangePeoplePartnerCommand {
  /** The employee whose PP is being set (`:employeeId`). */
  subjectId: string;
  /** The new People Partner (`targetId`) — the action has already checked it is
   *  an existing active `User` and not the employee. */
  targetId: string;
  /** Optimistic-concurrency token. Omitted → first assignment only (a PP that
   *  already exists → `stale`). Present → must equal the current PP. */
  expectedCurrentTargetId?: string;
  actorId: string;
}

export interface RemovePeoplePartnerCommand {
  subjectId: string;
  /** Optional optimistic-concurrency token (`?expectedCurrentTargetId=`). */
  expectedCurrentTargetId?: string;
  actorId: string;
}

/** `stale` maps to `409` (omitted token while a PP exists, a token that no
 *  longer matches, or a lost race); `assigned` carries the new bare edge. */
export type ChangePeoplePartnerResult =
  { outcome: 'assigned'; relationship: Relationship } | { outcome: 'stale' };

/** `not-found` → `404` (no current PP); `stale` → `409` (token mismatch). */
export type RemovePeoplePartnerResult =
  { outcome: 'removed' } | { outcome: 'not-found' } | { outcome: 'stale' };

export interface OrgRelationshipWriterPort {
  /**
   * Create the `direct` edge (`userId: subjectId`, `reportsToUserId: targetId`)
   * and one same-transaction `AccessJournal` row (`kind: 'manager'`,
   * `before: null`, `after:` the edge snapshot). A losing race on the
   * `relationships_one_direct_per_user` partial UNIQUE surfaces as a
   * `ConflictException` (Prisma P2002) and rolls the whole transaction back — no
   * journal row is written (DEC-UM-005).
   */
  assignManager(command: AssignManagerCommand): Promise<Relationship>;

  /**
   * Scoped lookup (`id: relationshipId`, `userId: subjectId`, `type: 'direct'`);
   * `false` when absent (the action maps that to a single `404`). Otherwise, in
   * one transaction: hard-delete the row and append one `AccessJournal` row
   * (`kind: 'manager'`, `before:` the edge snapshot, `after: null`).
   */
  revokeManager(command: RevokeManagerCommand): Promise<boolean>;

  /**
   * Create-or-atomically-replace the single `people_partner` edge for
   * `subjectId` and append one same-transaction `AccessJournal` row
   * (`kind: 'people_partner'`). No current edge + no token → create
   * (`before: null`). Current edge + token equal to it → hard-delete-then-create
   * inside one transaction (`operation: 'replace'`). Every other combination, and
   * a lost race on the `relationships_one_people_partner_per_user` partial UNIQUE
   * (Prisma P2002), returns `{ outcome: 'stale' }` with the whole transaction
   * rolled back — no journal row.
   */
  changePeoplePartner(
    command: ChangePeoplePartnerCommand,
  ): Promise<ChangePeoplePartnerResult>;

  /**
   * Hard-delete the current `people_partner` edge and append one
   * same-transaction `AccessJournal` row (`before:` the removed-edge snapshot,
   * `after: null`, `operation: 'delete'`). No current edge → `not-found`. A
   * supplied `expectedCurrentTargetId` that does not match the current PP →
   * `stale`.
   */
  removePeoplePartner(
    command: RemovePeoplePartnerCommand,
  ): Promise<RemovePeoplePartnerResult>;
}

// --- Story 4.3 — department membership (an owned temporal set) ---------------

export interface AddDepartmentMembershipCommand {
  /** The employee whose membership set is changing (`:id`). */
  subjectId: string;
  /** The department to add / move into. */
  departmentId: string;
  /** Present → atomic named-source move: close the current membership in
   *  `fromDepartmentId` and add `departmentId`, one transaction. Absent → a
   *  plain add (the employee keeps every existing current membership). */
  fromDepartmentId?: string;
  actorId: string;
}

export type AddDepartmentMembershipResult =
  | { outcome: 'added'; membership: DepartmentMembership }
  /** A plain add whose target is already a current membership. → 409. */
  | { outcome: 'already-member' }
  /** A move whose `fromDepartmentId` is not a current membership. → 409
   *  (decision: stale, not 404 — the request references a live sub-resource
   *  set, and a concurrent move is the likely cause). */
  | { outcome: 'stale-source' }
  /** `departmentId` (or `fromDepartmentId`) is not a `Department`. → 404. */
  | { outcome: 'department-not-found' };

export interface RemoveDepartmentMembershipCommand {
  subjectId: string;
  /** The department whose current membership row is closed. */
  departmentId: string;
  actorId: string;
}

export type RemoveDepartmentMembershipResult =
  | { outcome: 'removed' }
  /** No current membership in `departmentId` (unknown, or only a closed row). → 404. */
  | { outcome: 'not-found' }
  /** It is the employee's only current membership — the ≥1 floor (§4.17). → 409. */
  | { outcome: 'last-membership' };

// --- Story 4.3 — department manager (an AR `Policies` row + `UserPolicies`) ---

/** The pre-transaction read the `PUT/DELETE /departments/:deptId/manager`
 *  action needs for its 404 / self-assignment pre-checks. */
export interface DepartmentManagerContext {
  departmentExists: boolean;
  /** The user currently linked to the department's `unit-manager` AR policy, or
   *  `null` when the department has no manager. */
  currentManagerUserId: string | null;
}

export interface SetDepartmentManagerCommand {
  deptId: string;
  /** The new manager — the action has already checked it is an active `User`
   *  and not a forbidden self-assignment. */
  managerUserId: string;
  /** Optimistic-concurrency token. Omitted → first assignment only (a manager
   *  that already exists → `stale`). Present → must equal the current manager. */
  expectedCurrentManagerId?: string;
  actorId: string;
}

export type SetDepartmentManagerResult =
  | { outcome: 'set' }
  /** Omitted token while a manager exists, a token that no longer matches, or a
   *  token supplied while there is no manager. → 409. */
  | { outcome: 'stale' };

export interface RemoveDepartmentManagerCommand {
  deptId: string;
  actorId: string;
}

export type RemoveDepartmentManagerResult =
  { outcome: 'removed' } | { outcome: 'not-found' };

// Story 4.3 extends the port (declaration merging keeps the Story 4.1/4.2
// signatures above intact) with the department membership + department manager
// write paths.
export interface OrgRelationshipWriterPort {
  /**
   * Read the department's existence + current `unit-manager` AR-policy holder.
   * No write; used by the action for its 404 and self-assignment pre-checks.
   */
  loadDepartmentManagerContext(
    deptId: string,
  ): Promise<DepartmentManagerContext>;

  /**
   * Add a `DepartmentMembership` (`validFrom = today`, `validTo = null`) — or,
   * with `fromDepartmentId`, an atomic named-source move (close the source
   * membership `validTo = today`, then add the target). In the SAME transaction:
   * one `department_change` `UserEvents` row (`source: 'system'`, add form —
   * `details: { department }`) and one `AccessJournal` row
   * (`kind: 'department_membership'`).
   */
  addOrMoveDepartmentMembership(
    command: AddDepartmentMembershipCommand,
  ): Promise<AddDepartmentMembershipResult>;

  /**
   * Close the current `DepartmentMembership` in `departmentId` (`validTo =
   * today` — never a hard delete, the table is temporal). In the SAME
   * transaction: one `department_change` `UserEvents` row (`details:
   * { department, removed: true }`) and one `AccessJournal` row (`before:
   * { departmentId }`, `after: null`). The ≥1 floor and the unknown-membership
   * case short-circuit before the transaction with no write.
   */
  removeDepartmentMembership(
    command: RemoveDepartmentMembershipCommand,
  ): Promise<RemoveDepartmentMembershipResult>;

  /**
   * Create-or-repoint the department's single `unit-manager` AR `Policies` row +
   * `UserPolicies` link to `managerUserId`, and append one same-transaction
   * `AccessJournal` row (`kind: 'department_manager'`, `subjectDepartmentId:
   * deptId`, `subjectUserId: null`). No `UserEvents` row — a manager change is
   * not a career-timeline event. A stale optimistic predicate rolls the whole
   * transaction back — no journal row.
   */
  setDepartmentManager(
    command: SetDepartmentManagerCommand,
  ): Promise<SetDepartmentManagerResult>;

  /**
   * Remove the department's `unit-manager` `UserPolicies` link (the `Policies`
   * row is kept — a future re-assign repoints it) and append one
   * same-transaction `AccessJournal` row (`before: { managerUserId }`, `after:
   * null`). No current manager → `not-found` (→ 404).
   */
  removeDepartmentManager(
    command: RemoveDepartmentManagerCommand,
  ): Promise<RemoveDepartmentManagerResult>;
}

export const ORG_RELATIONSHIP_WRITER_PORT = Symbol(
  'ORG_RELATIONSHIP_WRITER_PORT',
);
