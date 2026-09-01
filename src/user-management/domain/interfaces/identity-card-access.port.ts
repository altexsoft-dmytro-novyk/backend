// UM-owned port for the one read-only authorization fact the S1 identity-card
// handler needs that the request guard cannot supply: whether this viewer
// *would* be allowed to edit the target's S1 identity fields, computed on the
// GET as a UI hint (`canEdit`). The audience gate for the read itself is the
// AccessControlGuard's job via `ACCESS_CONTROL_PORT.isAllowedForTarget`, so it
// is deliberately not exposed here.
//
// Named for the use case, not a facade passthrough. Its infrastructure
// implementation is the single place — besides the guard-facing
// `AccessControlPort` adapter — that consumes `AccessControlFacade` (AD-2
// forward import); `application/actions/` and `domain/services/` reach it only
// through `IdentityCardAccessService`.
export interface IdentityCardAccessPort {
  /**
   * The §2.2 dual gate, read-only: `true` iff the viewer holds the live
   * `user-management:edit` functional permission AND has `write` section
   * access to the target's S1 section. `false`-closed for every viewer today
   * (`user-management:edit` is unseeded).
   */
  canEditIdentityCard(viewerId: string, targetUserId: string): Promise<boolean>;
}

export const IDENTITY_CARD_ACCESS_PORT = Symbol('IDENTITY_CARD_ACCESS_PORT');
