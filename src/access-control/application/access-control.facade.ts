import { Injectable } from '@nestjs/common';
import type { Audience } from '../domain/audience';
import { AudienceResolverService } from '../domain/services/audience-resolver.service';

/**
 * The authorization entry point other contexts consume (AD-9). Phase 0 exposes
 * audience resolution only: `isAllowed` (functional roles) and
 * `canAccessSection` (the §3.2 matrix) arrive with their own slices, and a
 * consumer must not simulate either by reading policy rows or role flags.
 *
 * Callers receive a label per target and decide nothing else from it: what a
 * given audience may see is the owning context's projection contract, which may
 * narrow this result but never widen it.
 */
@Injectable()
export class AccessControlFacade {
  constructor(private readonly resolver: AudienceResolverService) {}

  /**
   * Live per-request resolution for one viewer over zero or more targets.
   * Every requested id comes back as a key; an empty request returns an empty
   * map without querying. Nothing here is cached across requests — a stale
   * audience is a leak, not an optimisation.
   */
  resolveAudiences(
    viewerId: string,
    employeeIds: string[],
  ): Promise<Map<string, Audience>> {
    return this.resolver.resolve(viewerId, employeeIds);
  }
}
