import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';
import { UserService } from '../../domain/services/user.service';
import { SetDepartmentManagerDto } from '../dtos/set-department-manager.dto';

/** The `PUT /departments/:deptId/manager` success body. */
export interface DepartmentManagerResponse {
  departmentId: string;
  managerUserId: string;
}

// Story 4.3 — the `PUT /departments/:deptId/manager` handler
// (create-or-repoint the department's single `unit-manager` AR policy). The
// capability gate (`org:relationships:write`) is `AccessControlGuard` via
// `@RequireFeature`; `SessionGuard` gives the `401`. This action owns the
// pre-transaction checks: unknown department → `404`; unknown manager target →
// `404`; inactive target → `422` (mirrors Story 4.2); self-assignment (the
// actor names itself while it does not already manage the department) → `400`
// before the transaction opens. `stale` (optimistic predicate) → `409`.
@Injectable()
export class SetDepartmentManagerAction {
  constructor(
    private readonly orgRelationships: OrgRelationshipService,
    private readonly userService: UserService,
  ) {}

  async execute(
    viewerId: string,
    deptId: string,
    dto: SetDepartmentManagerDto,
  ): Promise<DepartmentManagerResponse> {
    const context =
      await this.orgRelationships.loadDepartmentManagerContext(deptId);
    if (!context.departmentExists) {
      throw new NotFoundException();
    }

    const target = await this.userService.findById(dto.managerUserId);
    if (!target) {
      throw new NotFoundException();
    }
    if (target.isActive === false) {
      throw new UnprocessableEntityException(
        'the department manager target is not an active user',
      );
    }

    if (
      dto.managerUserId === viewerId &&
      context.currentManagerUserId !== viewerId
    ) {
      // §3.3 self-assignment — an app-level pre-check before the transaction
      // opens (400, never 403/409). Re-affirming an existing self-managed
      // department is not a self-assignment.
      throw new BadRequestException(
        'you cannot assign yourself as a department manager',
      );
    }

    const result = await this.orgRelationships.setDepartmentManager({
      deptId,
      managerUserId: dto.managerUserId,
      expectedCurrentManagerId: dto.expectedCurrentManagerId,
      actorId: viewerId,
    });
    if (result.outcome === 'stale') {
      throw new ConflictException(
        'the current department manager does not match expectedCurrentManagerId',
      );
    }

    return { departmentId: deptId, managerUserId: dto.managerUserId };
  }
}
