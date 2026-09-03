import { BadRequestException, Injectable } from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';
import { CreateRelationshipDto } from '../dtos/create-relationship.dto';
import {
  toRelationshipResponse,
  type RelationshipResponse,
} from '../dtos/relationship.response';

// Story 4.1 — the `POST /users/:id/relationships` handler. The capability gate
// (`org:relationships:write`) is `AccessControlGuard` via `@RequireFeature`
// (no-target `isAllowed` — DEC-UM-002); `SessionGuard` gives the `401`. This
// action owns only the self-assignment rejection and the delegation to the
// same-transaction edge+journal writer. A losing race on the `direct` partial
// UNIQUE surfaces from the repository as a `ConflictException` (409, DEC-UM-005).
@Injectable()
export class AssignManagerAction {
  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(
    viewerId: string,
    subjectId: string,
    dto: CreateRelationshipDto,
  ): Promise<RelationshipResponse> {
    if (subjectId === dto.targetId) {
      // §2.1 self-assignment: pinned to 400 here (the app guard), never a 409
      // and never a 500 leaking the raw `relationships_no_self_endpoint_check`.
      throw new BadRequestException(
        'an employee cannot be their own reports-to manager',
      );
    }

    const created = await this.orgRelationships.assignManager({
      subjectId,
      targetId: dto.targetId,
      actorId: viewerId,
    });

    return toRelationshipResponse(created);
  }
}
