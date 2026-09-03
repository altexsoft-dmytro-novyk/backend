import { createHash } from 'node:crypto';
import type { AccessJournalKind } from '../../generated/prisma/client';

// Interim `AccessJournal.idempotencyKey` derivation (Story 4.1 — um-rel-15
// scenario-stage decision; Story 4.2 adds `'replace'` for the atomic
// people-partner swap). A `direct`/`people_partner` edge row id (uuidv7) is
// created once and deleted once, so a retried mutation that reaches the same
// fact transition produces the same key and the unique constraint / `ON CONFLICT
// DO NOTHING` guard holds the journal to one row. No client-supplied request id
// is needed for this story. `node:crypto` is the Node standard library — the
// same accepted pattern as `magic-link.service.ts`.
//
// Lives in `infrastructure/` (not `domain/`) per the DDD layering rule: it is a
// persistence-shaping detail, not a domain concept.
// Story 4.3 adds the department-membership operations (`dept_add` / `dept_move`
// / `dept_remove`, keyed on the `DepartmentMembership` row id) and the
// department-manager operations (`dept_mgr_set` / `dept_mgr_remove`, keyed on
// the AR `Policies` row id + the manager user id). For a department-manager row
// the `subjectUserId` slot below carries the `deptId` (the row's real subject).
export type JournalOperation =
  | 'create'
  | 'replace'
  | 'delete'
  | 'dept_add'
  | 'dept_move'
  | 'dept_remove'
  | 'dept_mgr_set'
  | 'dept_mgr_remove';

export function accessJournalIdempotencyKey(
  actorUserId: string,
  subjectUserId: string,
  kind: AccessJournalKind,
  relationshipId: string,
  operation: JournalOperation,
): string {
  return createHash('sha256')
    .update(
      [actorUserId, subjectUserId, kind, relationshipId, operation].join('|'),
    )
    .digest('hex');
}
