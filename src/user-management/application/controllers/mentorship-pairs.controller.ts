import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { assertSectionRead } from '../section-access.helper';
import { ProfileDataRepository } from '../../infrastructure/profile-data.repository';

// S13 mentorship-pair assignment — a global resource (§4.11), not nested
// under /users/:id. The section-access target is the mentor (mentorId):
// assigning someone as a mentor is a write against the mentor's own S13
// section (§3.2: RW for Reporting/PP, R-pairs-only for Self).
@Controller('mentorship-pairs')
@UseGuards(SessionAuthGuard)
export class MentorshipPairsController {
  constructor(
    private readonly accessControl: AccessControlAction,
    private readonly repo: ProfileDataRepository,
  ) {}

  @Get()
  async listForUser(
    @Req() req: AuthenticatedRequest,
    @Query('userId') userId: string | undefined,
  ) {
    if (!userId || !(await this.repo.getUser(userId))) {
      throw new NotFoundException();
    }
    await assertSectionRead(this.accessControl, req.actorId, userId, 's13');
    const records = await this.repo.listSectionRecords(userId, 's13');
    return { pairs: records.map((r) => ({ id: r.id, ...r.data })) };
  }

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
  ) {
    const mentorId = body.mentorId as string | undefined;
    if (!mentorId || !(await this.repo.getUser(mentorId))) {
      throw new NotFoundException();
    }

    const level = await this.accessControl.canAccessSection(
      req.actorId,
      mentorId,
      's13',
    );
    if (level === 'none') throw new NotFoundException();
    if (level !== 'write') throw new ForbiddenException();
    if (await this.accessControl.isDeparted(mentorId)) {
      throw new ForbiddenException();
    }
    const hasPermission = await this.accessControl.hasSectionWritePermission(
      req.actorId,
      's13',
    );
    if (!hasPermission) throw new ForbiddenException();

    const created = await this.repo.createSectionRecord(
      mentorId,
      's13',
      // `status: 'active'` is a named consumer, not speculative: Epic 5's
      // departure executor (DepartureExecutorService) closes exactly this
      // field when either party departs (AD-16 side-effect bundle).
      { kind: 'pair', mentorId, menteeId: body.menteeId, status: 'active' },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }
}
