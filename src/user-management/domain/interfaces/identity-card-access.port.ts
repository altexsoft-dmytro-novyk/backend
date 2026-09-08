// UM-owned port for the one read-only authorization fact the identity-card
// handler needs that the request guard cannot supply: whether this viewer
// *would* be allowed to edit the target's `profile:identity` fields, computed
// on the GET as a UI hint (`canEdit`). The read gate itself is the
// SectionAccessGuard's job via
// `ACCESS_CONTROL_PORT.hasSectionAccess(..., 'read', ...)`, so it is
// deliberately not exposed here.
//
// Named for the use case, not a facade passthrough. Its infrastructure
// implementation is the single place — besides the guard-facing
// `AccessControlPort` adapter — that consumes `AccessControlFacade` (AD-2
// forward import); `application/actions/` and `domain/services/` reach it only
// through `IdentityCardAccessService`.
export interface IdentityCardAccessPort {
  /**
   * The identity-card edit decision, read-only. It is the same question the
   * `PATCH /users/:id` gate asks — `hasSectionAccess(viewer,
   * 'profile:identity', 'write', target)` — answered on a route that is not
   * gated by it, and resolved through the same adapter method so the hint and
   * the gate cannot drift apart.
   *
   * That question is the SCP 2026-09-04 D1 **dual gate**, audience-first:
   * `canAccessSection(viewer, 'profile:identity', target)` must already resolve
   * to `write` (reporting-line manager or assigned People Partner — Self and
   * Colleague are `read` per §3.2), and only then must `isAllowed(viewer,
   * 'profile:identity:write')` hold, which every active employee satisfies via
   * `DEFAULT_PERMISSIONS`. The functional half can only subtract: it is never
   * consulted for an audience the first half denied
   * (`docs/architecture/access-control.md:19`, NORMATIVE). The pre-4.1c
   * `user-management:edit` OR override is gone from this path.
   * `false`-closed for everyone else, including a `'none'` (deactivated or
   * unknown) target.
   */
  canEditIdentityCard(viewerId: string, targetUserId: string): Promise<boolean>;
}

export const IDENTITY_CARD_ACCESS_PORT = Symbol('IDENTITY_CARD_ACCESS_PORT');
