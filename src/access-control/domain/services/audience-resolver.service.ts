import { Inject, Injectable } from '@nestjs/common';
import type { Audience } from '../audience';
import {
  IDENTITY_PORT,
  type IdentityPort,
} from '../interfaces/identity.port';
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
    @Inject(IDENTITY_PORT)
    private readonly identity: IdentityPort,
  ) {}

  async resolve(
    viewerId: string,
    employeeIds: string[],
  ): Promise<Map<string, Set<Audience>>> {
    const audiences = new Map<string, Set<Audience>>();

    // Degenerate case first: an empty bulk must cost nothing at all — no graph
    // walk, no query, no round trip (§7's 500-record budget depends on it).
    // This sits ABOVE identity validation deliberately: there is nothing to
    // derive, so there is nothing to fail closed about, and an invalid viewer
    // must not buy a lookup on an empty request either.
    if (employeeIds.length === 0) {
      return audiences;
    }

    const targets = [...new Set(employeeIds)];

    // Identity before derivation (CAP-1). The viewer and every target must be
    // confirmed present and active before any audience — Self included — is
    // derived, so this precedes both the graph read and the
    // `id === viewerId` check. One lookup answers for every party at once.
    const confirmed = await this.identity.findActiveUserIds([
      viewerId,
      ...targets,
    ]);

    // An unconfirmed viewer fails the whole call, not one entry: with no valid
    // identity there is nothing to resolve an audience *for*, so no
    // relationship fact is read at all. Every requested id still gets a key —
    // an empty `Set` is the answer, not a missing entry.
    if (!confirmed.has(viewerId)) {
      for (const id of targets) {
        audiences.set(id, new Set<Audience>());
      }
      return audiences;
    }

    // Self is exclusive and never reaches the graph; an unconfirmed target
    // never reaches it either, because deriving facts for an identity that
    // failed validation is the derivation CAP-1 orders us not to do.
    const others = targets.filter(
      (id) => id !== viewerId && confirmed.has(id),
    );

    const facts =
      others.length > 0
        ? await this.graph.loadAudienceFacts(viewerId, others)
        : { reportingTargets: [], ppTargets: [] };
    const reporting = new Set(facts.reportingTargets);
    const pp = new Set(facts.ppTargets);

    for (const id of targets) {
      // Missing or deactivated target: empty, never Self and never the
      // Colleague floor. The floor is for a confirmed employee with no
      // qualifying relationship, not for an identity that does not resolve.
      if (!confirmed.has(id)) {
        audiences.set(id, new Set<Audience>());
        continue;
      }

      if (id === viewerId) {
        // Both parties are confirmed by the same lookup — where target is the
        // viewer, that one confirmation settles both.
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
