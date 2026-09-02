// UM-owned port for the two read-only authorization facts the career-timeline
// route needs. Mirrors `identity-card-access.port.ts`: named for the use case,
// not a facade passthrough. Its infrastructure implementation
// (`career-timeline-access-facade.adapter.ts`) is the single place — besides the
// guard-facing `AccessControlPort` adapter and the identity-card adapter — that
// consumes `AccessControlFacade` across the AD-2 boundary; `application/actions/`
// reach it only through `CareerTimelineAccessService`.

export interface CareerTimelineAccessPort {
  /**
   * §3.2 row S9 READ audience (Self `R`; Reporting line / Project line / PP
   * `RW`; Colleague `—`).
   *
   * INTERIM (v1.5): `AccessControlFacade.canAccessSection` does not answer
   * `'profile:timeline'` yet (S1/S10/S11 only). Implemented via
   * `resolveAudiences(viewerId, [targetUserId])` — allow iff the resolved set
   * intersects `{ self, reporting, pp }`. Project line is fail-closed
   * system-wide (the resolver does not emit it) and starts matching with no
   * change here once Access Control ships it. Replace with
   * `canAccessSection('profile:timeline', …)` when that AC increment reaches
   * stage-3-production (tracked in
   * `_bmad-output/implementation-artifacts/access-control/deferred-work.md`).
   */
  canReadTimeline(viewerId: string, targetUserId: string): Promise<boolean>;

  /**
   * The §2.2 dual gate for manual add/correct/delete (Stories 3.2/3.3):
   * `isAllowed(viewer, 'profile:timeline:write')` AND an S9 write audience,
   * further narrowed by DEC-UM-001 (assigned PP + direct Unit Manager only).
   *
   * `'profile:timeline:write'` is unseeded and the DEC-UM-001 narrowing is not
   * built, so this returns `false` for every viewer today — which is correct.
   * It is wired through the facade now so the `canEdit` envelope hint cannot
   * drift from the write path Story 3.2 will enforce.
   */
  canEditTimeline(viewerId: string, targetUserId: string): Promise<boolean>;
}

export const CAREER_TIMELINE_ACCESS_PORT = Symbol(
  'CAREER_TIMELINE_ACCESS_PORT',
);
