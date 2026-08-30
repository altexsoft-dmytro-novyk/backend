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

  @Get('roles')
  async list(@Req() req: AuthenticatedRequest) {
    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'manage_roles',
    );
    if (!allowed) throw new ForbiddenException();
    const roles = await this.accessControl.listPolicies();
    return { roles };
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
