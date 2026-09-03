import type { AccessJournal } from '../../../generated/prisma/client';

// The `GET /users/:id/access-journal` item shape (um-rel-15 scenario-stage
// decision). Deliberately minimal: `idempotencyKey` is an internal write-guard
// column and is never exposed. The resource is append-only, so the envelope
// carries no `canEdit` hint (nobody edits a journal row).
export interface AccessJournalRowResponse {
  id: string;
  occurredAt: Date;
  actorUserId: string;
  // Story 4.3: nullable — a `department_manager` row has a department subject,
  // not a user. The `GET /users/:id/access-journal` reader filters by
  // `subjectUserId`, so in practice it only ever returns user-subject rows
  // (this stays populated); `subjectDepartmentId` is surfaced only when set.
  subjectUserId: string | null;
  subjectDepartmentId?: string;
  kind: string;
  before: unknown;
  after: unknown;
}

// The success body — a `{ data }` envelope (house convention), newest-first.
export interface AccessJournalEnvelope {
  data: AccessJournalRowResponse[];
}

export function toAccessJournalRow(
  row: AccessJournal,
): AccessJournalRowResponse {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    actorUserId: row.actorUserId,
    subjectUserId: row.subjectUserId,
    kind: row.kind,
    before: row.before,
    after: row.after,
    // Only present on a department-subject row — keeps the user-subject item
    // shape (and its exact key set, `um-rel-15`) unchanged.
    ...(row.subjectDepartmentId !== null
      ? { subjectDepartmentId: row.subjectDepartmentId }
      : {}),
  };
}
