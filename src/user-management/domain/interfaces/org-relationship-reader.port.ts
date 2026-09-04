// UM-owned READ port for the current org edges behind
// `GET /users/:id/relationships` (Story 6.1). Deliberately separate from the
// transactional, journal-aware `OrgRelationshipWriterPort`: a read has neither
// concern and binds a different Prisma client (`this.prisma`, never a `tx`), so
// mixing the two would invite a read that accidentally enrolls in a write
// transaction. Its Prisma implementation is
// `infrastructure/org-relationship-reader.repository.ts`; only
// `OrgRelationshipReadService` (a `domain/services/` seam) holds this token, and
// `application/actions/` reach it through that service (AD-2).

/**
 * One current org edge of the subject: the row exists, so it is "current"
 * (`Relationship` is hard-deleted — no `validTo`, no flag). `id` is the
 * `Relationship.id` a reports-to reassignment (DEC-UM-005 DELETE-then-POST) or
 * a PP optimistic-concurrency token needs. `target` is the endpoint user
 * (`reportsTo`), always populated for a `direct` / `people_partner` edge.
 */
export interface CurrentEdge {
  id: string;
  type: 'direct' | 'people_partner';
  target: { id: string; firstName: string; lastName: string };
}

export interface OrgRelationshipReaderPort {
  /**
   * The subject's current `direct` (manager) and `people_partner` edges — one
   * query, no N+1. `project` edges, closed/historical edges, and edges whose
   * target user is deactivated are excluded. Partial UNIQUE indexes guarantee
   * ≤1 of each type per subject. Ordered `direct` first, then `people_partner`,
   * then by `id`. Returns `[]` when the subject has no qualifying edge.
   */
  listCurrentEdges(subjectId: string): Promise<CurrentEdge[]>;
}

export const ORG_RELATIONSHIP_READER_PORT = Symbol(
  'ORG_RELATIONSHIP_READER_PORT',
);
