// UM-owned port for the one read-authorization fact the
// `GET /users/:id/access-journal` route needs. Mirrors
// `career-timeline-access.port.ts`: named for the use case, not a facade
// passthrough. Its infrastructure implementation
// (`access-journal-access-facade.adapter.ts`) is a sanctioned place UM consumes
// `AccessControlFacade` across the AD-2 boundary; `application/actions/` reach it
// only through `AccessJournalAccessService`.

export interface AccessJournalAccessPort {
  /**
   * §3.4: the subject's *current Reporting-line manager* or *assigned People
   * Partner* may read their access journal. The full-profile-overlay holder is
   * also a reader, but that leg is deferred behind the §2.4 `full`-audience
   * resolver.
   *
   * INTERIM (`// INTERIM`, expiry = the §2.4 `full`-audience resolver reaching
   * stage-3-production — `_bmad-output/implementation-artifacts/access-control/deferred-work.md`):
   * `resolveAudiences(viewerId, [subjectId]) ∩ { reporting, pp } ≠ ∅`. **Self is
   * NOT a reader. HR Admin by functional role alone is NOT a reader** — there is
   * deliberately no `isAllowed` leg here (unlike the timeline's "edit implies
   * read").
   */
  canReadAccessJournal(viewerId: string, subjectId: string): Promise<boolean>;
}

export const ACCESS_JOURNAL_ACCESS_PORT = Symbol('ACCESS_JOURNAL_ACCESS_PORT');
