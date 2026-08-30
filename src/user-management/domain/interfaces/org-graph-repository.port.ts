// AD-1: domain-owned port for the org-graph facts this context's own
// tables (User, Relationship, Departure) hold. No Prisma/NestJS import here.
export const ORG_GRAPH_REPOSITORY_PORT = Symbol('ORG_GRAPH_REPOSITORY_PORT');

export interface OrgGraphRepositoryPort {
  /** AD-17: effective departure, independent of whether appliedAt has landed. */
  isDeparted(userId: string): Promise<boolean>;

  /**
   * AD-24: one indexed recursive-CTE query. Fail-closed: does not continue
   * the walk past a node whose user row is gone (broken/orphaned edge) or
   * whose departure is already effective (AD-16/17 due-node cutoff).
   */
  isInReportingLine(actorId: string, targetId: string): Promise<boolean>;

  /** Direct reports-to edge only, no recursion (AD-26). */
  isDirectManager(actorId: string, targetId: string): Promise<boolean>;

  /** Phase 1: direct-assigned PP endpoint only (AD-13 HR-line deferred). */
  isAssignedPP(actorId: string, targetId: string): Promise<boolean>;

  userExists(userId: string): Promise<boolean>;
}
