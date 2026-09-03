import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';
import { AddDepartmentMembershipDto } from '../dtos/add-department-membership.dto';

/** The `POST /users/:id/departments` success body — the bare created
 *  membership row (no `{ data }` envelope, consistent with the relationship
 *  routes). */
export interface DepartmentMembershipResponse {
  id: string;
  userId: string;
  departmentId: string;
  validFrom: Date;
}

// Story 4.3 — the `POST /users/:id/departments` handler (add, or — with
// `fromDepartmentId` — an atomic named-source move). The capability gate
// (`org:relationships:write`) is `AccessControlGuard` via `@RequireFeature`
// (no-target `isAllowed`); `SessionGuard` gives the `401`. The same-transaction
// membership + `department_change` event + `department_membership` journal write
// is in the repository; this action owns only the outcome → HTTP mapping.
@Injectable()
export class AddDepartmentMembershipAction {
  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(
    viewerId: string,
    subjectId: string,
    dto: AddDepartmentMembershipDto,
  ): Promise<DepartmentMembershipResponse> {
    const result = await this.orgRelationships.addOrMoveDepartmentMembership({
      subjectId,
      departmentId: dto.departmentId,
      fromDepartmentId: dto.fromDepartmentId,
      actorId: viewerId,
    });

    if (result.outcome === 'department-not-found') {
      throw new NotFoundException();
    }
    if (result.outcome === 'stale-source') {
      // Decision: a move whose `fromDepartmentId` is not a current membership is
      // `409` (stale), not `404` — the request names a live membership set and a
      // concurrent move is the likely cause.
      throw new ConflictException(
        'the employee is not currently a member of fromDepartmentId',
      );
    }
    if (result.outcome === 'already-member') {
      throw new ConflictException(
        'the employee already holds a current membership in this department',
      );
    }

    const { membership } = result;
    return {
      id: membership.id,
      userId: membership.userId,
      departmentId: membership.departmentId,
      validFrom: membership.validFrom,
    };
  }
}
