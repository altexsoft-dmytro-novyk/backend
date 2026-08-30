import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { SelfAssignmentError } from '../../domain/services/relationship-write.service';
import { RelationshipWriteService } from '../../domain/services/relationship-write.service';

// Story 4.3's department-manager half. AD-25 keeps full department CRUD
// (§4.17, the *manage departments* permission) out of scope here — this is
// the one operation Epic 4's dedicated permission ("change organisational
// relationships") covers: who manages an existing department, not creating
// or deleting departments themselves.
@Controller('departments')
@UseGuards(SessionAuthGuard)
export class DepartmentsController {
  constructor(
    private readonly accessControl: AccessControlAction,
    private readonly relationshipWrite: RelationshipWriteService,
  ) {}

  @Post(':id/manager')
  async changeManager(
    @Req() req: AuthenticatedRequest,
    @Param('id') departmentId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!(await this.relationshipWrite.departmentExists(departmentId))) {
      throw new NotFoundException();
    }

    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'change organisational relationships',
    );
    if (!allowed) throw new ForbiddenException();

    const value = (body.value as string | null | undefined) ?? null;
    const expectedCurrent =
      'expectedCurrent' in body
        ? (body.expectedCurrent as string | null)
        : undefined;

    if (value !== null && !(await this.relationshipWrite.userExists(value))) {
      throw new NotFoundException();
    }

    try {
      const result = await this.relationshipWrite.changeDepartmentManager(
        req.actorId,
        departmentId,
        value,
        expectedCurrent,
      );
      if (result.outcome === 'conflict') throw new ConflictException();
      if (result.outcome === 'not_found') throw new NotFoundException();
      return { departmentId, managerId: result.value };
    } catch (err) {
      if (err instanceof SelfAssignmentError) throw new ForbiddenException();
      throw err;
    }
  }
}
