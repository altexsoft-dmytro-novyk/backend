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
   * `RW`; Colleague `—`), WIDENED by Story 3.2 with "edit implies read".
   *
   * INTERIM (v1.5): `AccessControlFacade.canAccessSection` does not answer
   * `'profile:timeline'` yet — the kernel matrix holds `profile:identity` /
   * `profile:leave` / `profile:projects` only (the §3.2 S1 / §3.2 S10 /
   * §3.2 S11 rows). Implemented as
   * `resolveAudiences(viewerId, [targetUserId]) ∩ { self, reporting, pp,
   * project }` OR `isAllowed(viewer, 'profile:timeline:write')` — the latter is
   * the timeline-scoped interim of the §2.4 Full-profile-access grant (Dmytro,
   * 2026-09-02). Project line is fail-closed system-wide (the resolver does not
   * emit it) and starts matching with no change here once Access Control ships
   * it. Replace with `canAccessSection('profile:timeline', …)` when that AC
   * increment reaches stage-3-production (tracked in
   * `_bmad-output/implementation-artifacts/access-control/deferred-work.md`).
   */
  canReadTimeline(viewerId: string, targetUserId: string): Promise<boolean>;

  /**
   * The manual add/correct/delete gate (Stories 3.2/3.3).
   *
   * INTERIM (Story 3.2, career-timeline/README.md — Dmytro 2026-09-02):
   * `isAllowed(viewer, 'profile:timeline:write')` ALONE — a feature action, NO
   * data-audience half. The only seeded holder is `hr-admin`, which carries no
   * S9 write audience at all (§2.2 NORMATIVE), so requiring the audience half
   * now would close the gate to everyone. `targetUserId` is unused at this
   * stage. The §2.2 dual gate — the permission AND `canAccessSection(
   * 'profile:timeline', target) === 'write'`, narrowed by DEC-UM-001 to
   * assigned PP + direct Unit Manager — is the deferred target, reactivated
   * with the FR-permission-matrix grant to the PP / UM roles.
   */
  canEditTimeline(viewerId: string, targetUserId: string): Promise<boolean>;
}

export const CAREER_TIMELINE_ACCESS_PORT = Symbol(
  'CAREER_TIMELINE_ACCESS_PORT',
);
