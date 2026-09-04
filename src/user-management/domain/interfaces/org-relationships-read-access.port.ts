// UM-owned port for the one read-authorization fact
// `GET /users/:id/relationships` needs (Story 6.1). Modelled on
// `access-journal-access.port.ts` — named for the use case, not a facade
// passthrough, and deliberately NOT "section" (that word collides with
// `AccessControlFacade.canAccessSection`, a different concept). Its
// infrastructure implementation
// (`org-relationships-read-access-facade.adapter.ts`) is a sanctioned place UM
// consumes `AccessControlFacade` across the AD-2 boundary;
// `application/actions/` reach it only through `OrgRelationshipsReadAccessService`.

export interface OrgRelationshipsReadAccessPort {
  /**
   * **Gate B — DECIDED 2026-09-04 (Dmytro).** The viewer may read the subject's
   * current manager / People Partner edges iff:
   *
   *   `resolveAudiences(viewerId, [subjectId]) ∩ { reporting, pp } ≠ ∅`
   *   **OR** `isAllowed(viewerId, 'org:relationships:write')`
   *
   * The OR-leg ("edit implies read") is the deliberate divergence from the
   * access-journal read gate, which omits any functional-permission leg: the
   * no-target HR capability that performs reassignments must be able to read the
   * `relationshipId` / PP token those reassignments need. Self alone, colleague
   * alone, and an unresolved subject (empty audience set) with no capability →
   * denied.
   *
   * INTERIM: same expiry trigger as the journal gate — the §2.4 `full`-audience
   * resolver reaching stage-3-production
   * (`_bmad-output/implementation-artifacts/access-control/deferred-work.md`).
   */
  canRead(viewerId: string, subjectId: string): Promise<boolean>;
}

export const ORG_RELATIONSHIPS_READ_ACCESS_PORT = Symbol(
  'ORG_RELATIONSHIPS_READ_ACCESS_PORT',
);
