import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';

// Story 4.3 — the `DELETE /departments/:deptId/manager` handler. Removes the
// `unit-manager` `UserPolicies` link (the `Policies` row is kept — a later
// re-assign repoints it) + a same-transaction `department_manager` journal row
// (`after: null`). No current manager (or unknown department) → `404`.
@Injectable()
export class RemoveDepartmentManagerAction {
  private readonly logger = new Logger(RemoveDepartmentManagerAction.name);

  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(viewerId: string, deptId: string): Promise<void> {
    const result = await this.orgRelationships.removeDepartmentManager({
      deptId,
      actorId: viewerId,
    });
    if (result.outcome === 'not-found') {
      throw new NotFoundException();
    }
    this.logger.log(
      `department manager removed: department ${deptId} (by ${viewerId})`,
    );
  }
}
