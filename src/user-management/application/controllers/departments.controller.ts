import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RemoveDepartmentManagerAction } from '../actions/remove-department-manager.action';
import {
  SetDepartmentManagerAction,
  type DepartmentManagerResponse,
} from '../actions/set-department-manager.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import { RequireFeature } from '../decorators/require-feature.decorator';
import { SetDepartmentManagerDto } from '../dtos/set-department-manager.dto';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SessionGuard } from '../guards/session.guard';
import type { Session } from '../../domain/interfaces/session-resolver.port';

// Epic 4 Story 4.3 — the first `/departments` route (there is no `/departments`
// resource root before this story; departments were import-created only). It
// carries only the department-**manager** fact (a fixed-cardinality 0-or-1
// edge, mirroring the people-partner atomic shape). Department **membership**
// stays on `/users/:id/departments` (an owned collection on the employee).
//
// Both writes carry the dedicated `org:relationships:write` capability
// (no-target `isAllowed` through the facade — never a role-name check);
// `AccessControlGuard` enforces it from `@RequireFeature`. `SessionGuard`
// produces every `401`.
const ORG_RELATIONSHIPS_WRITE_FEATURE = 'org:relationships:write';

@Controller('departments')
@UseGuards(SessionGuard, AccessControlGuard)
export class DepartmentsController {
  constructor(
    private readonly setDepartmentManagerAction: SetDepartmentManagerAction,
    private readonly removeDepartmentManagerAction: RemoveDepartmentManagerAction,
  ) {}

  // `PUT` defaults to `200` in Nest; the body is the bare
  // `{ departmentId, managerUserId }` fact.
  @Put(':deptId/manager')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async setManager(
    @CurrentSession() session: Session,
    @Param('deptId') deptId: string,
    @Body() dto: SetDepartmentManagerDto,
  ): Promise<DepartmentManagerResponse> {
    return this.setDepartmentManagerAction.execute(session.userId, deptId, dto);
  }

  // `200` with an empty body.
  @Delete(':deptId/manager')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async removeManager(
    @CurrentSession() session: Session,
    @Param('deptId') deptId: string,
  ): Promise<void> {
    await this.removeDepartmentManagerAction.execute(session.userId, deptId);
  }
}
