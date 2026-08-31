import { AudienceResolverService } from './audience-resolver.service';
import type { IdentityPort } from '../interfaces/identity.port';
import type {
  AudienceFacts,
  RelationshipGraphPort,
} from '../interfaces/relationship-graph.port';

// These Phase-0 cases pin the resolution RULES over confirmed identities, so
// the identity seam answers "everyone asked about is present and active".
// Unconfirmed viewers and targets are not faked here: their behavior is proven
// against real PostgreSQL rows in
// test/access-control/acm3-inactive-identity.e2e-spec.ts (AD-15).
const ACTIVE_IDENTITY: IdentityPort = {
  findActiveUserIds: (userIds: string[]) => Promise.resolve(new Set(userIds)),
};

// Stage-2 unit coverage for docs/test-cases/access-control-foundation/.
// The graph port is faked here on purpose: these cases pin the resolution
// RULES, while the real recursive walk and its fail-closed filters are proven
// against PostgreSQL in test/access-control/audience-resolution.e2e-spec.ts
// (AD-15 — a fake may only stand in for what another test proves for real).
class FakeGraph implements RelationshipGraphPort {
  calls = 0;
  lastTargets: string[] = [];

  constructor(
    private readonly reporting: string[] = [],
    private readonly pp: string[] = [],
  ) {}

  loadAudienceFacts(
    _viewerId: string,
    targetIds: string[],
  ): Promise<AudienceFacts> {
    this.calls += 1;
    this.lastTargets = targetIds;
    return Promise.resolve({
      reportingTargets: this.reporting.filter((id) => targetIds.includes(id)),
      ppTargets: this.pp.filter((id) => targetIds.includes(id)),
    });
  }
}

const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';
const PAULA = 'paula';
const HANA = 'hana';
const COLIN = 'colin';
const ERIN = 'erin';
const FRANK = 'frank';

const expectAudiences = (
  audiences: Map<string, Set<string>>,
  id: string,
  expected: string[],
) => {
  expect([...(audiences.get(id) ?? [])].sort()).toEqual([...expected].sort());
};

describe('AudienceResolverService (Phase 0)', () => {
  describe('ACF-AU-01 · self', () => {
    it('resolves Self for the viewer and never queries the graph for that target', async () => {
      const graph = new FakeGraph([ALICE], [ALICE]);
      const resolver = new AudienceResolverService(graph, ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(ALICE, [ALICE]);

      expectAudiences(audiences, ALICE, ['self']);
      // Self is exclusive: it must not be merged with a manager or PP column,
      // so the viewer's own id is excluded from the graph lookup entirely.
      expect(graph.lastTargets).not.toContain(ALICE);
    });
  });

  describe('ACF-AU-02 · direct reporting line', () => {
    it('resolves Reporting for a manager over a live direct report', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([ALICE]), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(BOB, [ALICE]);

      expectAudiences(audiences, ALICE, ['reporting']);
    });
  });

  describe('ACF-AU-03 · transitive reporting line', () => {
    it('resolves Reporting for an ancestor reached through the recursive walk', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([BOB, ALICE]), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(CAROL, [ALICE]);

      expectAudiences(audiences, ALICE, ['reporting']);
    });
  });

  describe('ACF-AU-04 · direct people partner', () => {
    it('resolves PP from the assignment fact alone, with no reporting edge', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([], [ALICE]), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(PAULA, [ALICE]);

      expectAudiences(audiences, ALICE, ['pp']);
    });
  });

  describe('ACF-AU-05 · colleague fallback', () => {
    it('falls back to Colleague when no relationship qualifies', async () => {
      const resolver = new AudienceResolverService(new FakeGraph(), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(COLIN, [ALICE]);

      expectAudiences(audiences, ALICE, ['colleague']);
    });
  });

  describe('ACF-FC-01 · broken reports-to edge', () => {
    it('grants nothing to an ancestor when the walk stopped at the broken node', async () => {
      // The graph reports no reachable descendants: the deactivated manager is
      // neither a target nor a bridge, so Frank never reaches Erin.
      const resolver = new AudienceResolverService(new FakeGraph([]), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(FRANK, [ERIN]);

      expectAudiences(audiences, ERIN, ['colleague']);
    });
  });

  describe('ACF-FC-02 · PP HR line withheld', () => {
    it('gives the PP’s own manager nothing over the PP’s employee', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([PAULA], []), ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(HANA, [ALICE]);

      expectAudiences(audiences, ALICE, ['colleague']);
    });
  });

  describe('ACF-FC-03 · empty bulk', () => {
    it('returns an empty map without touching the graph', async () => {
      const graph = new FakeGraph([ALICE], [ALICE]);
      const resolver = new AudienceResolverService(graph, ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(COLIN, []);

      expect(audiences.size).toBe(0);
      expect(graph.calls).toBe(0);
    });
  });

  describe('bulk resolution', () => {
    it('returns a key for every requested target in one graph call', async () => {
      const graph = new FakeGraph([ALICE], [ERIN]);
      const resolver = new AudienceResolverService(graph, ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(BOB, [ALICE, ERIN, COLIN, BOB]);

      expectAudiences(audiences, ALICE, ['reporting']);
      expectAudiences(audiences, BOB, ['self']);
      expectAudiences(audiences, COLIN, ['colleague']);
      expectAudiences(audiences, ERIN, ['pp']);
      expect(audiences.size).toBe(4);
      expect(graph.calls).toBe(1);
    });

    it('deduplicates repeated target ids without extra graph calls', async () => {
      const graph = new FakeGraph([ALICE]);
      const resolver = new AudienceResolverService(graph, ACTIVE_IDENTITY);

      const audiences = await resolver.resolve(BOB, [ALICE, ALICE, ALICE]);

      expect(audiences.size).toBe(1);
      expect(graph.lastTargets).toEqual([ALICE]);
    });

    it('returns both reporting and PP when a viewer holds both audiences', async () => {
      const resolver = new AudienceResolverService(
        new FakeGraph([ALICE], [ALICE]),
        ACTIVE_IDENTITY,
      );

      const audiences = await resolver.resolve(BOB, [ALICE]);

      expectAudiences(audiences, ALICE, ['pp', 'reporting']);
    });
  });
});
