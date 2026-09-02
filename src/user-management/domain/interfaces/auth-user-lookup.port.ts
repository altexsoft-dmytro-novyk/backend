// Read port for the `/auth` sub-area's own active-user lookup (Epic 2 Story 2.1).
//
// Deliberately NOT reusing `UserRepositoryPort.findByWorkEmail`: the `/auth`
// resource owns its own files with no overlap with `/users` (epic-2-context.md),
// and this lookup carries auth-specific semantics — "active" here means the
// account flag is on AND there is no current `dismissed` employment status
// (DEC-UM-012 / auth/README decision 5).

export interface AuthUser {
  id: string;
  workEmail: string;
}

export interface AuthUserLookupPort {
  /**
   * The active user for this exact (already-normalized) `workEmail`, or `null`
   * when there is no match, the account is deactivated, or the employee is
   * currently dismissed.
   */
  findActiveByWorkEmail(workEmail: string): Promise<AuthUser | null>;

  /**
   * The active user for this id, or `null` when there is no match, the account
   * is deactivated, or the employee is currently dismissed. Story 2.2's consume
   * flow re-checks account state at consume time against the token owner (a
   * token minted while active must not yield a session after departure —
   * `um-auth-06`).
   */
  findActiveById(userId: string): Promise<AuthUser | null>;
}

export const AUTH_USER_LOOKUP_PORT = Symbol('AUTH_USER_LOOKUP_PORT');
