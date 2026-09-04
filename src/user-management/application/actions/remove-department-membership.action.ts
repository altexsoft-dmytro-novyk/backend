import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';

// Story 4.3 — the `DELETE /users/:id/departments/:departmentId` handler. Closes
// the current membership row (`validTo = today`) + a same-transaction
// `department_change` event (`removed: true`) + a `department_membership`
// journal row. Two leak-free refusals: no current membership → `404`; the
// employee's only current membership → `409` (the ≥1 floor, §4.17).
@Injectable()
export class RemoveDepartmentMembershipAction {
  private readonly logger = new Logger(RemoveDepartmentMembershipAction.name);

  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(
    viewerId: string,
    subjectId: string,
    departmentId: string,
  ): Promise<void> {
    const result = await this.orgRelationships.removeDepartmentMembership({
      subjectId,
      departmentId,
      actorId: viewerId,
    });

    if (result.outcome === 'not-found') {
      // Leak-free: a plain `NotFoundException` (no id in the body).
      throw new NotFoundException();
    }
    if (result.outcome === 'last-membership') {
      throw new ConflictException(
        'employee must belong to at least one department; assign another before removing this one',
      );
    }

    this.logger.log(
      `department membership removed: ${subjectId} from department ${departmentId} (by ${viewerId})`,
    );
  }
}
