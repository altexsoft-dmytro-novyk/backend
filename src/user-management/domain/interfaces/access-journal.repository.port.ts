import type { AccessJournal } from '../../../generated/prisma/client';

// UM-owned READ port for the §3.4 `access_journal` collection — the data source
// for `GET /users/:id/access-journal`. Its Prisma implementation is
// `infrastructure/access-journal.repository.ts`; only `AccessJournalService`
// (a `domain/services/` seam) holds this token, and `application/actions/` reach
// it through that service (AD-2). The WRITE path is not here — journal rows are
// co-written inside the `Relationship` mutation's transaction by
// `OrgRelationshipWriterPort` (AD-11).

export interface AccessJournalRepositoryPort {
  /**
   * Every `AccessJournal` row for `subjectUserId`, newest-first
   * (`occurredAt DESC`) — the §3.4 read order. Append-only, so no soft-delete
   * filter.
   */
  listForSubject(subjectUserId: string): Promise<AccessJournal[]>;
}

export const ACCESS_JOURNAL_REPOSITORY_PORT = Symbol(
  'ACCESS_JOURNAL_REPOSITORY_PORT',
);
