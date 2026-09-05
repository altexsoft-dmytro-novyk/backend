import { Injectable, Logger } from '@nestjs/common';
import type { Audience } from '../domain/audience';
import { SECTION_ACCESS_MATRIX } from '../domain/constants/section-access-matrix';
import { AudienceResolverService } from '../domain/services/audience-resolver.service';
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
    return best;
  }
}
