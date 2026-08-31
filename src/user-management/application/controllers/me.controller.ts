import {
  Controller,
  Get,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { ProfileDataRepository } from '../../infrastructure/profile-data.repository';

// The signed-in user's own identity plus the feature permissions they hold —
// a read-only projection the frontend uses to decide which controls to show
// (no dead buttons). Every permission is resolved live through the same
// AccessControl facade the mutating routes gate on (AD-9), so this can never
// report more than the actor can actually do.
//
// The list is deliberately the closed set of §2.3 named permissions the UI
// keys UI affordances off — not `section:sN:write` (those govern per-section
// edit, which the profile endpoints already surface as 200 vs 403).
const UI_PERMISSIONS = [
  'manage_roles',
  'change organisational relationships',
  'record a departure',
  'edit the career timeline',
  'maintain CDS records',
  'assign and end mentorships',
  'manage custom fields',
] as const;

@Controller('me')
@UseGuards(SessionAuthGuard)
export class MeController {
  constructor(
    private readonly accessControl: AccessControlAction,
    private readonly repo: ProfileDataRepository,
  ) {}

  @Get()
  async me(@Req() req: AuthenticatedRequest) {
    const user = await this.repo.getUser(req.actorId);
    // The guard already verified the token and rejected a departed actor, so
    // a missing row here means the account was hard-deleted mid-session.
    if (!user) throw new NotFoundException();

    const held = await Promise.all(
      UI_PERMISSIONS.map((name) =>
        this.accessControl.isAllowed(req.actorId, name),
      ),
    );
    const permissions = UI_PERMISSIONS.filter((_, i) => held[i]);

    const employmentStatus = (await this.accessControl.isDeparted(user.id))
      ? 'dismissed'
      : await this.repo.getEmploymentStatusValue(user.id);

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      workEmail: user.workEmail,
      photo: user.photo,
      employmentStatus,
      permissions,
    };
  }
}
