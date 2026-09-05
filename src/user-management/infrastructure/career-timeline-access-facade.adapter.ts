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
// mutation (Stories 3.2/3.3). Story 3.2 ships it granted to the `hr-admin` role
// only; the default kernel/ACM seed does not carry it yet (tracked in
// career-timeline/README.md "What blocks Stage-2"), so a real deployment grants
// it via the FR policy until that lands.
const TIMELINE_WRITE_PERMISSION = 'profile:timeline:write';

@Injectable()
export class CareerTimelineAccessFacadeAdapter implements CareerTimelineAccessPort {
  constructor(private readonly facade: AccessControlFacade) {}

  async canReadTimeline(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    // INTERIM: `AccessControlFacade.canAccessSection` answers
    // 'profile:identity'/'profile:leave'/'profile:projects' only — it does not
    // answer 'profile:timeline' yet. Replace this
    // `resolveAudiences` rule with
    // `canAccessSection('profile:timeline', viewerId, targetUserId) !== 'none'`
    // when that AC increment reaches stage-3-production
    // (_bmad-output/implementation-artifacts/access-control/deferred-work.md —
    // "`profile:timeline` `canAccessSection` support").
    const audiences = await this.facade.resolveAudiences(viewerId, [
      targetUserId,
    ]);
    const resolved = audiences.get(targetUserId);
    if (resolved) {
      for (const audience of resolved) {
        if (TIMELINE_READ_AUDIENCES.has(audience)) {
          return true;
        }
      }
    }
    // INTERIM: "edit implies read" (Dmytro, 2026-09-02) — a holder of
    // `profile:timeline:write` can read the timeline back. This is the
    // timeline-scoped interim of the §2.4 Full-profile-access grant; the
    // resolver-level `full` audience / bypass that lets a §2.4 holder read
    // EVERY section is a deferred Access Control item (deferred-work.md). Same
    // expiry trigger as the audience rule above.
    return this.facade.isAllowed(viewerId, TIMELINE_WRITE_PERMISSION);
  }

  async canEditTimeline(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    // INTERIM (Story 3.2, career-timeline/README.md — Dmytro 2026-09-02): the
    // manual-write gate at this stage is `isAllowed(viewer,
    // 'profile:timeline:write')` ALONE — a feature action, NO data-audience
    // half. The only seeded holder is `hr-admin`, which carries no S9 write
    // audience at all (§2.2 NORMATIVE), so requiring the audience half now
    // would close the gate to everyone. `targetUserId` is unused at this stage:
    // DEC-UM-001 audience narrowing (assigned PP + direct Unit Manager,
    // per-assignee scoped) is the deferred target, reactivated with the
    // FR-permission-matrix grant of `profile:timeline:write` to the PP / UM
    // roles.
    void targetUserId;
    return this.facade.isAllowed(viewerId, TIMELINE_WRITE_PERMISSION);
  }
}
