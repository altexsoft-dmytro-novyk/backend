import { Injectable } from '@nestjs/common';
import { AccessControlFacade } from '../../access-control/application/access-control.facade';
import type { AccessJournalAccessPort } from '../domain/interfaces/access-journal-access.port';

// The production binding for `ACCESS_JOURNAL_ACCESS_PORT`. An `infrastructure/`
// adapter is a sanctioned place User Management consumes `AccessControlFacade`
// across the AD-2 boundary (like `career-timeline-access-facade.adapter.ts`);
// wired by token in `user-management.module.ts` and injected only by
// `AccessJournalAccessService`.

// §3.4 access-journal READ audiences under the interim rule: the subject's
// current Reporting-line manager or assigned People Partner. Self is NOT a
// reader; HR Admin by functional role alone is NOT a reader (no `isAllowed`
// leg).
const JOURNAL_READ_AUDIENCES = new Set(['reporting', 'pp']);

@Injectable()
export class AccessJournalAccessFacadeAdapter implements AccessJournalAccessPort {
  constructor(private readonly facade: AccessControlFacade) {}

  async canReadAccessJournal(
    viewerId: string,
    subjectId: string,
  ): Promise<boolean> {
    // INTERIM: `AccessControlFacade` has no `full` audience and no
    // journal-specific section today, so this route gates the same sanctioned
    // way the S9 timeline read gate does (um-ct-11 / um-rel-15):
    // `resolveAudiences(viewer, [subject]) ∩ { reporting, pp } ≠ ∅`. Replace
    // with `∩ { reporting, pp, full }` (or an explicit journal-reader predicate)
    // when the §2.4 `full`-audience resolver reaches stage-3-production
    // (_bmad-output/implementation-artifacts/access-control/deferred-work.md —
    // the `full`-audience resolver item now names this reader leg). An
    // unresolved `subjectId` yields an empty audience set → denied, so a
    // nonexistent `:id` is covered here too (no 404 enumeration surface).
    const audiences = await this.facade.resolveAudiences(viewerId, [subjectId]);
    const resolved = audiences.get(subjectId);
    if (!resolved) {
      return false;
    }
    for (const audience of resolved) {
      if (JOURNAL_READ_AUDIENCES.has(audience)) {
        return true;
      }
    }
    return false;
  }
}
