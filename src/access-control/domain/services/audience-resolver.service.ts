import { Inject, Injectable } from '@nestjs/common';
import type { Audience } from '../audience';
import {
  RELATIONSHIP_GRAPH_PORT,
  type RelationshipGraphPort,
} from '../interfaces/relationship-graph.port';

/**
 * Resolves the Phase-0 audience of one viewer over any number of targets
 * (AD-10). Live, bulk, fail-closed, never persisted.
 *
 * Phase 0 returns exactly one label per target. Reporting is preferred over PP
 * when a viewer holds both — under the current mapping the two grant
 * identically, so this is a labelling convention, not a permission decision.
 * The best-of merge across section columns arrives with the section matrix.
 */
@Injectable()
export class AudienceResolverService {
  constructor(
    @Inject(RELATIONSHIP_GRAPH_PORT)
    private readonly graph: RelationshipGraphPort,
  ) {}

  async resolve(
    viewerId: string,
    employeeIds: string[],
  ): Promise<Map<string, Audience>> {
    const audiences = new Map<string, Audience>();

    // Degenerate case first: an empty bulk must cost nothing at all — no graph
    // walk, no query, no round trip (§7's 500-record budget depends on it).
    if (employeeIds.length === 0) {
      return audiences;
    }

    const targets = [...new Set(employeeIds)];

    // Self is evaluated before anything else and is exclusive: a viewer inside
    // their own reporting chain does not also inherit manager columns over
    // their own record, so their id never reaches the graph query.
    const others = targets.filter((id) => id !== viewerId);
    if (others.length === 0) {
      for (const id of targets) {
        audiences.set(id, 'self');
      }
      return audiences;
    }

    const facts = await this.graph.loadAudienceFacts(viewerId, others);
    const reporting = new Set(facts.reportingTargets);
    const pp = new Set(facts.ppTargets);

    for (const id of targets) {
      if (id === viewerId) {
        audiences.set(id, 'self');
      } else if (reporting.has(id)) {
        audiences.set(id, 'reporting');
      } else if (pp.has(id)) {
        audiences.set(id, 'pp');
      } else {
        // No qualifying relationship — Colleague is the floor, never a gap.
        audiences.set(id, 'colleague');
      }
    }

    return audiences;
  }
}
