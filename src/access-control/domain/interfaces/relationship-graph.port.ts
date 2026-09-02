/**
 * The facts a single audience resolution needs, for one viewer over a bulk of
 * targets. Both sets are answered from live `Relationship` rows; the adapter
 * reads them inside one transaction so the two graphs cannot be torn apart by
 * a concurrent org change.
 */
export type AudienceFacts = {
  /** Targets whose `direct` chain ascends to the viewer (walk starts at each target). */
  reportingTargets: string[];
  /** Targets whose assigned `people_partner` endpoint is the viewer. */
  ppTargets: string[];
};

export interface RelationshipGraphPort {
  /**
   * `targetIds` never contains the viewer: Self is decided before the graph is
   * consulted and is exclusive of the manager and PP columns.
   */
  loadAudienceFacts(
    viewerId: string,
    targetIds: string[],
  ): Promise<AudienceFacts>;
}

export const RELATIONSHIP_GRAPH_PORT = Symbol('RELATIONSHIP_GRAPH_PORT');
