import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';

// Story 4.1 — the `DELETE /users/:id/relationships/:relationshipId` handler. The
// capability gate is `AccessControlGuard` via `@RequireFeature`; `SessionGuard`
// gives the `401`. A scoped lookup that finds no `direct` edge for
// `(relationshipId, subjectId)` — unknown id, cross-employee id, non-`direct`
// id, or an already-revoked edge — collapses to one `404` with no
// 404-vs-403 enumeration surface. On success the hard delete and one
// `AccessJournal` row commit together.
@Injectable()
export class RevokeManagerAction {
  private readonly logger = new Logger(RevokeManagerAction.name);

  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(
    viewerId: string,
    subjectId: string,
    relationshipId: string,
  ): Promise<void> {
    const revoked = await this.orgRelationships.revokeManager({
      subjectId,
      relationshipId,
      actorId: viewerId,
    });

    if (!revoked) {
      throw new NotFoundException();
    }
    this.logger.log(
      `manager relationship ${relationshipId} revoked for ${subjectId} (by ${viewerId})`,
    );
  }
}
