import { Injectable } from '@nestjs/common';
import { AccessControlFacade } from '../../access-control/application/access-control.facade';
import type { CareerTimelineAccessPort } from '../domain/interfaces/career-timeline-access.port';

// The production binding for `CAREER_TIMELINE_ACCESS_PORT`. An `infrastructure/`
// adapter is a sanctioned place User Management consumes `AccessControlFacade`
// across the AD-2 boundary (like `access-control-facade.adapter.ts` and the
// identity-card adapter); wired by token in `user-management.module.ts` and
// injected only by `CareerTimelineAccessService`.

// The audiences that grant career-timeline READ under the interim rule (§3.2 S9:
// Self `R`; Reporting line / Project line / PP `RW`; Colleague `—`). Project
// line is fail-closed system-wide — the resolver does not emit it yet — and is
// listed here so it starts matching with no change once Access Control ships it.
const TIMELINE_READ_AUDIENCES = new Set(['self', 'reporting', 'pp', 'project']);

// The FR-matrix `<domain>:<section>:<op>` permission key for manual timeline
// mutation (Stories 3.2/3.3). Unseeded today, so `isAllowed` is `false` for
// every viewer — Story 3.2's scenario stage owns the final holder decision.
const TIMELINE_WRITE_PERMISSION = 'profile:timeline:write';

@Injectable()
export class CareerTimelineAccessFacadeAdapter implements CareerTimelineAccessPort {
  constructor(private readonly facade: AccessControlFacade) {}

  async canReadTimeline(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    // INTERIM: `AccessControlFacade.canAccessSection` answers 'S1'/'S10'/'S11'
    // only — it does not answer 'profile:timeline' yet. Replace this
    // `resolveAudiences` rule with
    // `canAccessSection('profile:timeline', viewerId, targetUserId) !== 'none'`
    // when that AC increment reaches stage-3-production
    // (_bmad-output/implementation-artifacts/access-control/deferred-work.md —
    // "`profile:timeline` `canAccessSection` support").
    const audiences = await this.facade.resolveAudiences(viewerId, [
      targetUserId,
    ]);
    const resolved = audiences.get(targetUserId);
    if (!resolved) {
      return false;
    }
    for (const audience of resolved) {
      if (TIMELINE_READ_AUDIENCES.has(audience)) {
        return true;
      }
    }
    return false;
  }

  async canEditTimeline(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    // The §2.2 dual gate. `profile:timeline:write` is unseeded, so this short-
    // circuits `false` for every viewer today — the correct current answer.
    // Wired through the facade now so the `canEdit` envelope hint tracks the
    // Story 3.2 write path and cannot drift.
    const hasPermission = await this.facade.isAllowed(
      viewerId,
      TIMELINE_WRITE_PERMISSION,
    );
    if (!hasPermission) {
      return false;
    }
    // S9 write audience. DEC-UM-001 narrows this to assigned PP + direct Unit
    // Manager; that narrowing is Story 3.2's to build. Until `canAccessSection`
    // answers 'profile:timeline', reuse the interim audience rule.
    return this.canReadTimeline(viewerId, targetUserId);
  }
}
