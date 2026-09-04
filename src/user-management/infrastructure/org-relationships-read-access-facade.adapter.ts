import { Injectable } from '@nestjs/common';
import { AccessControlFacade } from '../../access-control/application/access-control.facade';
import type { OrgRelationshipsReadAccessPort } from '../domain/interfaces/org-relationships-read-access.port';

// The production binding for `ORG_RELATIONSHIPS_READ_ACCESS_PORT`. An
// `infrastructure/` adapter is a sanctioned place User Management consumes
// `AccessControlFacade` across the AD-2 boundary (like
// `access-journal-access-facade.adapter.ts` and
// `career-timeline-access-facade.adapter.ts`); wired by token in
// `user-management.module.ts` and injected only by
// `OrgRelationshipsReadAccessService`.

// §Boundaries — the audiences that grant `GET /users/:id/relationships` read.
// Same set as the access-journal read gate (`JOURNAL_READ_AUDIENCES`).
const ORG_RELATIONSHIPS_READ_AUDIENCES = new Set(['reporting', 'pp']);

// Gate B OR-leg (Dmytro, 2026-09-04): the no-target HR capability that performs
// reports-to / PP reassignments — "edit implies read". This is the conscious
// divergence from the journal-read gate, which has NO functional-permission leg.
const ORG_RELATIONSHIPS_WRITE_PERMISSION = 'org:relationships:write';

@Injectable()
export class OrgRelationshipsReadAccessFacadeAdapter implements OrgRelationshipsReadAccessPort {
  constructor(private readonly facade: AccessControlFacade) {}

  async canRead(viewerId: string, subjectId: string): Promise<boolean> {
    // INTERIM: `AccessControlFacade` has no `full` audience and no
    // relationships-section `canAccessSection` answer today, so this gate uses
    // the sanctioned `resolveAudiences` rule (same as um-rel-15 / um-ct-11).
    // An unresolved `subjectId` yields an empty audience set → the audience leg
    // is false, and a nonexistent `:id` is already a 404 in the action before
    // this is ever called. Replace with an explicit relationships-reader
    // predicate (or `∩ { reporting, pp, full }`) when the §2.4 `full`-audience
    // resolver reaches stage-3-production
    // (_bmad-output/implementation-artifacts/access-control/deferred-work.md).
    const audiences = await this.facade.resolveAudiences(viewerId, [subjectId]);
    const resolved = audiences.get(subjectId);
    if (resolved) {
      for (const audience of resolved) {
        if (ORG_RELATIONSHIPS_READ_AUDIENCES.has(audience)) {
          return true;
        }
      }
    }

    // OR-leg — "edit implies read". A holder of `org:relationships:write` reads
    // the current edges (and their ids) so it can perform a reassignment.
    return this.facade.isAllowed(viewerId, ORG_RELATIONSHIPS_WRITE_PERMISSION);
  }
}
