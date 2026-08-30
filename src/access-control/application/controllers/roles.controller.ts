import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessControlService } from '../../domain/services/access-control.service';
import { SessionAuthGuard } from '../guards/session-auth.guard';
import type { AuthenticatedRequest } from '../guards/session-auth.guard';

// AD-9/AD-25: the functional-role catalog admin surface. Pure FR gate (CAP-3)
// — not audience/matrix-based, so a missing permission is 403, never 404.
@Controller()
@UseGuards(SessionAuthGuard)
export class RolesController {
  constructor(private readonly accessControl: AccessControlService) {}

  // um-seed-03 (FR-1/AD-12): the response is a bare array of
  // { id, name, holderCount, holders }, not an envelope — no fixed DTO was
  // settled anywhere upstream (see that test's own top-of-file comment), so
  // this shape is the minimum that lets "HR Admin has exactly one holder,
  // matched by workEmail" be asserted at all.
  @Get('roles')
  async list(@Req() req: AuthenticatedRequest) {
    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'manage_roles',
    );
    if (!allowed) throw new ForbiddenException();
    return this.accessControl.listPolicies();
  }

  @Delete('users/:userId/policies/:policyId')
  @HttpCode(204)
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('policyId') policyId: string,
  ) {
    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'manage_roles',
    );
    if (!allowed) throw new ForbiddenException();
    await this.accessControl.revokeUserPolicy(userId, policyId);
  }
}
