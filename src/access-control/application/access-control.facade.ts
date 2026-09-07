import { Injectable, Logger } from '@nestjs/common';
import type { Audience } from '../domain/audience';
import { SECTION_ACCESS_MATRIX } from '../domain/constants/section-access-matrix';
import { AudienceResolverService } from '../domain/services/audience-resolver.service';
import { FullProfileOverlayService } from '../domain/services/full-profile-overlay.service';
import { FunctionalRoleEvaluatorService } from '../domain/services/functional-role-evaluator.service';

export type SectionAccess = 'none' | 'read' | 'write';

/**
 * The authorization entry point other contexts consume (AD-9). Phase 0 exposes
 * audience resolution and base section access. A consumer must not simulate
 * either by reading policy rows or role flags.
 *
 * Callers receive every applicable audience per target and decide nothing else
 * from it: what a given audience may see is the owning context's projection
 * contract, which may narrow this result but never widen it.
 */
@Injectable()
export class AccessControlFacade {
  private readonly logger = new Logger(AccessControlFacade.name);

  constructor(
    private readonly resolver: AudienceResolverService,
    private readonly functionalRoles: FunctionalRoleEvaluatorService,
    private readonly fullProfileOverlay: FullProfileOverlayService,
  ) {}

  /** Live global functional-permission decision (CAP-4); never cached. */
  async isAllowed(userId: string, permissionKey: string): Promise<boolean> {
    const allowed = await this.functionalRoles.isAllowed(userId, permissionKey);
    this.logger.debug(`isAllowed(${userId}, "${permissionKey}") → ${allowed}`);
    return allowed;
  }

  /**
   * Live per-request resolution for one viewer over zero or more targets.
   * Every requested id comes back as a key; an empty request returns an empty
   * map without querying. Nothing here is cached across requests — a stale
   * audience is a leak, not an optimisation.
   */
  resolveAudiences(
    viewerId: string,
    employeeIds: string[],
  ): Promise<Map<string, Set<Audience>>> {
    return this.resolver.resolve(viewerId, employeeIds);
  }

  /**
   * Base CAP-5 decision for the supported profile sections only. Projection,
   * overlays, and operation-specific checks belong to the owning consumer and
   * may only narrow this result.
   */
  async canAccessSection(
    viewerId: string,
    section: string,
    targetEmployeeId: string,
  ): Promise<SectionAccess> {
    const access = await this.resolveSectionAccess(
      viewerId,
      section,
      targetEmployeeId,
    );
    this.logger.debug(
      `canAccessSection(${viewerId}, ${section}, ${targetEmployeeId}) → ${access}`,
    );
    return access;
  }

  private async resolveSectionAccess(
    viewerId: string,
    section: string,
    targetEmployeeId: string,
  ): Promise<SectionAccess> {
    const row = SECTION_ACCESS_MATRIX[section];
    if (!row) {
      return 'none';
    }

    const audiences = await this.resolveAudiences(viewerId, [targetEmployeeId]);
    const targetAudiences = audiences.get(targetEmployeeId);

    if (!targetAudiences || targetAudiences.size === 0) {
      return 'none';
    }

    const RANK: Record<SectionAccess, number> = { none: 0, read: 1, write: 2 };
    let best: SectionAccess = 'none';
    for (const audience of targetAudiences) {
      const cell = row[audience] ?? 'none';
      if (RANK[cell] > RANK[best]) {
        best = cell;
      }
    }

    // §2.4 full-profile-access overlay (PLAT-E4-S4.2c). Strictly AFTER the
    // best-of-audience merge above, and only reached for a target that
    // already survived the `!targetAudiences || targetAudiences.size === 0`
    // early return (CAP-1: an unconfirmed/inactive target must stay 'none'
    // regardless of who is viewing — never move this check any earlier).
    // AF-1 ruling (2026-09-07, PO): "max(Self, full-profile)" means the merge
    // result so far, not a literal comparison against only the viewer's own
    // Self audience — so `best` here IS that merge result. The overlay can
    // only ever raise `best` from 'none' to 'read'; it never touches an
    // existing 'read' or 'write' and never supplies anything else
    // (access-control.md:345, "Overlay is not a matrix column").
    //
    // CORRECTED 2026-09-07 (John, PM, code-review finding): guarded on
    // `best === 'none'`, not the wider `best !== 'write'` this file
    // originally shipped with. The wider guard called `isHolder()` — a real
    // DB round trip — on every already-'read' resolution too, which is the
    // overwhelmingly common case on this hot path, for a result the overlay
    // can provably never change once `best` is above 'none'. No test
    // asserts a call count on `isHolder`/`isActiveHolder` (only the
    // resulting `SectionAccess` value), so this is a behavior-preserving
    // optimization: `acm11-fpo-06`'s regression-lock property — a holder's
    // result on every real section is byte-identical to a non-holder's —
    // remains completely true and tested; only that scenario doc's
    // narrative claim that "the branch is exercised" for an already-'read'
    // result is now inaccurate prose, corrected there with a dated note.
    if (best === 'none') {
      const isHolder = await this.fullProfileOverlay.isHolder(viewerId);
      if (isHolder) {
        best = 'read';
      }
    }
    return best;
  }
}
