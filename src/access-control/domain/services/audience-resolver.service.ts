import { Inject, Injectable } from '@nestjs/common';
import { ORG_GRAPH_READER_PORT } from '../interfaces/org-graph-reader.port';
import type { OrgGraphReaderPort } from '../interfaces/org-graph-reader.port';
import { Audience } from '../types';

// AD-1: only domain/services/ may inject a port token. AD-4: recomputed
// live on every call, no cache.
@Injectable()
export class AudienceResolverService {
  constructor(
    @Inject(ORG_GRAPH_READER_PORT)
    private readonly orgGraph: OrgGraphReaderPort,
  ) {}

  /**
   * AD-14: Self is exclusive and evaluated first. Otherwise Reporting/PP can
   * co-occur (merged later by the caller, best-of per section). Project is
   * structurally omitted in Phase 1 (README: "withhold negatives only — no
   * positive grants yet"). Colleague is the fallback when nothing else
   * applies. Empty target existence is the caller's job (404 vs audience).
   */
  async resolveAudiences(
    actorId: string,
    targetId: string,
  ): Promise<Set<Audience>> {
    if (actorId === targetId) {
      return new Set<Audience>(['self']);
    }

    const [inReportingLine, isAssignedPP] = await Promise.all([
      this.orgGraph.isInReportingLine(actorId, targetId),
      this.orgGraph.isAssignedPP(actorId, targetId),
    ]);

    const audiences = new Set<Audience>();
    if (inReportingLine) audiences.add('reporting');
    if (isAssignedPP) audiences.add('pp');

    if (audiences.size === 0) {
      audiences.add('colleague');
    }

    return audiences;
  }
}
