/**
 * Identity confirmation for one audience resolution (CAP-1).
 *
 * A separate seam from `RelationshipGraphPort` on purpose: whether a person
 * exists and is active is not an org fact, and CAP-1 requires that question to
 * be answered BEFORE any audience is derived — Self included. Folding it into
 * the relationship graph would make the ordering an implementation detail of a
 * query rather than a rule the resolver enforces.
 */
export interface IdentityPort {
  /**
   * The subset of `userIds` that exists and is active. An id absent from the
   * result is **unconfirmed**, which covers both a deactivated row and no row
   * at all — CAP-1 treats missing and inactive identically, so the caller must
   * not distinguish them either.
   */
  findActiveUserIds(userIds: string[]): Promise<Set<string>>;
}

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');
