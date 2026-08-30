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
 * Returns every applicable audience per target so downstream merge can take
 * the best column per section (§3.2 multi-audience merge). Self is exclusive;
 * Colleague is the floor when nothing else applies.
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
  ): Promise<Map<string, Set<Audience>>> {
    const audiences = new Map<string, Set<Audience>>();

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
        audiences.set(id, new Set<Audience>(['self']));
      }
      return audiences;
    }

    const facts = await this.graph.loadAudienceFacts(viewerId, others);
    const reporting = new Set(facts.reportingTargets);
    const pp = new Set(facts.ppTargets);

    for (const id of targets) {
      if (id === viewerId) {
        audiences.set(id, new Set<Audience>(['self']));
        continue;
      }

      const labels = new Set<Audience>();
      if (reporting.has(id)) {
        labels.add('reporting');
      }
      if (pp.has(id)) {
        labels.add('pp');
      }
      if (labels.size === 0) {
        // No qualifying relationship — Colleague is the floor, never alongside another audience.
        labels.add('colleague');
      }
      audiences.set(id, labels);
    }

    return audiences;
  }
}
