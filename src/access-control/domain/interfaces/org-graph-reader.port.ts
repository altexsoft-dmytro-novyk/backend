// AD-3: access-control -> user-management for org-graph facts. Domain-owned
// port; implemented by an infrastructure adapter that calls
// user-management's exported application-layer query service, in-process,
// live, never cached. No Prisma/NestJS import here (AD-1).
export const ORG_GRAPH_READER_PORT = Symbol('ORG_GRAPH_READER_PORT');

export interface OrgGraphReaderPort {
  /** True if the given user has an effective (possibly not-yet-applied) departure. AD-17. */
  isDeparted(userId: string): Promise<boolean>;

  /**
   * True if actorId is anywhere in targetId's transitive Reporting line
   * (recursive `direct` reports-to walk, AD-24 one indexed query). Fail
   * closed on a broken/orphaned edge or a due intermediate node (AD-16/17):
   * the walk does not continue past a node whose user row is gone or whose
   * departure is already effective.
   */
  isInReportingLine(actorId: string, targetId: string): Promise<boolean>;

  /** True if actorId is targetId's direct reports-to holder (no recursion). AD-26. */
  isDirectManager(actorId: string, targetId: string): Promise<boolean>;

  /** Phase 1: direct-assigned PP endpoint only, no HR-line recursion (AD-13 deferred). */
  isAssignedPP(actorId: string, targetId: string): Promise<boolean>;

  userExists(userId: string): Promise<boolean>;
}
