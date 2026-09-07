/**
 * §2.4 full-profile-access overlay (PLAT-E4-S4.2c). Structurally parallel to
 * `FunctionalRoleRepositoryPort` — the read-only holder lookup
 * `FullProfileOverlayService` delegates to.
 */
export interface FullProfileAccessPort {
  /**
   * True iff userId is a CURRENT, ACTIVE holder — inactive users never count,
   * mirroring the CAP-1 discipline `AudienceResolverService` already applies
   * and the `isActiveUser` gate `FunctionalRoleEvaluatorService` already uses
   * for `DEFAULT_PERMISSIONS`
   * (`functional-role-evaluator.service.ts:23-30`).
   */
  isActiveHolder(userId: string): Promise<boolean>;
}

export const FULL_PROFILE_ACCESS_PORT = Symbol('FULL_PROFILE_ACCESS_PORT');
