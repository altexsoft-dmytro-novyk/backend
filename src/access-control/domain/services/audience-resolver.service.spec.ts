import { AudienceResolverService } from './audience-resolver.service';
import type {
  AudienceFacts,
  RelationshipGraphPort,
} from '../interfaces/relationship-graph.port';

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

describe('AudienceResolverService (Phase 0)', () => {
  describe('ACF-AU-01 · self', () => {
    it('resolves Self for the viewer and never queries the graph for that target', async () => {
      const graph = new FakeGraph([ALICE], [ALICE]);
      const resolver = new AudienceResolverService(graph);

      const audiences = await resolver.resolve(ALICE, [ALICE]);

      expect(audiences.get(ALICE)).toBe('self');
      // Self is exclusive: it must not be merged with a manager or PP column,
      // so the viewer's own id is excluded from the graph lookup entirely.
      expect(graph.lastTargets).not.toContain(ALICE);
    });
  });

  describe('ACF-AU-02 · direct reporting line', () => {
    it('resolves Reporting for a manager over a live direct report', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([ALICE]));

      const audiences = await resolver.resolve(BOB, [ALICE]);

      expect(audiences.get(ALICE)).toBe('reporting');
    });
  });

  describe('ACF-AU-03 · transitive reporting line', () => {
    it('resolves Reporting for an ancestor reached through the recursive walk', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([BOB, ALICE]));

      const audiences = await resolver.resolve(CAROL, [ALICE]);

      expect(audiences.get(ALICE)).toBe('reporting');
    });
  });

  describe('ACF-AU-04 · direct people partner', () => {
    it('resolves PP from the assignment fact alone, with no reporting edge', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([], [ALICE]));

      const audiences = await resolver.resolve(PAULA, [ALICE]);

      expect(audiences.get(ALICE)).toBe('pp');
    });
  });

  describe('ACF-AU-05 · colleague fallback', () => {
    it('falls back to Colleague when no relationship qualifies', async () => {
      const resolver = new AudienceResolverService(new FakeGraph());

      const audiences = await resolver.resolve(COLIN, [ALICE]);

      expect(audiences.get(ALICE)).toBe('colleague');
    });
  });

  describe('ACF-FC-01 · broken reports-to edge', () => {
    it('grants nothing to an ancestor when the walk stopped at the broken node', async () => {
      // The graph reports no reachable descendants: the deactivated manager is
      // neither a target nor a bridge, so Frank never reaches Erin.
      const resolver = new AudienceResolverService(new FakeGraph([]));

      const audiences = await resolver.resolve(FRANK, [ERIN]);

      expect(audiences.get(ERIN)).toBe('colleague');
    });
  });

  describe('ACF-FC-02 · PP HR line withheld', () => {
    it('gives the PP’s own manager nothing over the PP’s employee', async () => {
      const resolver = new AudienceResolverService(new FakeGraph([PAULA], []));

      const audiences = await resolver.resolve(HANA, [ALICE]);

      expect(audiences.get(ALICE)).toBe('colleague');
    });
  });

  describe('ACF-FC-03 · empty bulk', () => {
    it('returns an empty map without touching the graph', async () => {
      const graph = new FakeGraph([ALICE], [ALICE]);
      const resolver = new AudienceResolverService(graph);

      const audiences = await resolver.resolve(COLIN, []);

      expect(audiences.size).toBe(0);
      expect(graph.calls).toBe(0);
    });
  });

  describe('bulk resolution', () => {
    it('returns a key for every requested target in one graph call', async () => {
      const graph = new FakeGraph([ALICE], [ERIN]);
      const resolver = new AudienceResolverService(graph);

      const audiences = await resolver.resolve(BOB, [ALICE, ERIN, COLIN, BOB]);

      expect([...audiences.entries()].sort()).toEqual([
        [ALICE, 'reporting'],
        [BOB, 'self'],
        [COLIN, 'colleague'],
        [ERIN, 'pp'],
      ]);
      expect(graph.calls).toBe(1);
    });

    it('deduplicates repeated target ids without extra graph calls', async () => {
      const graph = new FakeGraph([ALICE]);
      const resolver = new AudienceResolverService(graph);

      const audiences = await resolver.resolve(BOB, [ALICE, ALICE, ALICE]);

      expect(audiences.size).toBe(1);
      expect(graph.lastTargets).toEqual([ALICE]);
    });

    it('prefers the reporting label when a viewer is both manager and PP', async () => {
      // Phase 0 returns exactly one label per target; both grant identically
      // under the provisional mapping, so precedence is a reporting-first
      // convention, not a permission decision.
      const resolver = new AudienceResolverService(
        new FakeGraph([ALICE], [ALICE]),
      );

      const audiences = await resolver.resolve(BOB, [ALICE]);

      expect(audiences.get(ALICE)).toBe('reporting');
    });
  });
});
