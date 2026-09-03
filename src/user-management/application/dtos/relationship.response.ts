import type { Relationship } from '../../../generated/prisma/client';

// The `POST /users/:id/relationships` success body — the bare created edge.
// `projectId` is never part of a `direct` edge and is not exposed here.
export interface RelationshipResponse {
  id: string;
  userId: string;
  type: string;
  reportsToUserId: string | null;
}

export function toRelationshipResponse(
  relationship: Relationship,
): RelationshipResponse {
  return {
    id: relationship.id,
    userId: relationship.userId,
    type: relationship.type,
    reportsToUserId: relationship.reportsToUserId,
  };
}
