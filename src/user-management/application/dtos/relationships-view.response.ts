import type { CurrentEdge } from '../../domain/interfaces/org-relationship-reader.port';

// The `GET /users/:id/relationships` item + envelope shape (Story 6.1).
// Distinct from the bare-edge `relationship.response.ts` (the POST/PUT write
// bodies): this is a read projection that renames `id` → `relationshipId` (the
// token DEC-UM-005 / the PP optimistic-concurrency guard consume) and inlines
// the target user's display identity. Bare `{ data }` collection, NO `canEdit`
// — mirrors `GET /users/:id/access-journal` (append-only / pure read).
//
// Inlining the target's `{ id, firstName, lastName }` is safe: those three are
// the §3.3.4 always-visible identity minimum for any active user — the same
// projection basis as Story 6.4's batch identity lookup — so no per-viewer
// audience filtering is owed on the manager/PP name here.
export interface CurrentEdgeView {
  relationshipId: string;
  type: 'direct' | 'people_partner';
  target: { id: string; firstName: string; lastName: string };
}

export interface RelationshipsEnvelope {
  data: CurrentEdgeView[];
}

export function toCurrentEdgeView(edge: CurrentEdge): CurrentEdgeView {
  return {
    relationshipId: edge.id,
    type: edge.type,
    target: {
      id: edge.target.id,
      firstName: edge.target.firstName,
      lastName: edge.target.lastName,
    },
  };
}
