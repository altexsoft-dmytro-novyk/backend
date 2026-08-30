import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { ProfileDataRepository } from '../../infrastructure/profile-data.repository';
import { assertSectionWrite } from '../section-access.helper';

// S14 action items and tasks — a global resource (§4.5), filtered by
// ?assigneeId=. The section-access target is always the assignee.
@Controller('action-items')
@UseGuards(SessionAuthGuard)
export class ActionItemsController {
  constructor(
    private readonly accessControl: AccessControlAction,
    private readonly repo: ProfileDataRepository,
  ) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('assigneeId') assigneeId?: string,
  ) {
    if (!assigneeId || !(await this.repo.getUser(assigneeId))) {
      throw new NotFoundException();
    }
    const level = await this.accessControl.canAccessSection(
      req.actorId,
      assigneeId,
      's14',
    );
    if (level === 'none') throw new NotFoundException();
    const records = await this.repo.listSectionRecords(assigneeId, 's14');
    return { actionitems: records.map((r) => ({ id: r.id, ...r.data })) };
  }

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: Record<string, unknown>,
  ) {
    const assigneeId = body.assigneeId as string | undefined;
    if (!assigneeId || !(await this.repo.getUser(assigneeId))) {
      throw new NotFoundException();
    }
    // §4.3: Self holds only R+mark-complete for their own S14 — creating a
    // new item is not part of that exception, so this always follows the
    // general write gate (Self's S14 level is 'read', so self-creation is
    // correctly denied by assertSectionWrite below, no special-case needed).
    await assertSectionWrite(
      this.accessControl,
      req.actorId,
      assigneeId,
      's14',
    );
    const created = await this.repo.createSectionRecord(
      assigneeId,
      's14',
      { assigneeId, title: body.title, status: 'open' },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }

  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    let record = await this.repo.findSectionRecordById(id);
    if (record && record.section !== 's14') throw new NotFoundException();

    if (!record && body.status === 'completed') {
      // §4.3 exception: Self may mark their own action item complete. No
      // POST /action-items ever ran to create this specific id in some
      // matrix scenarios (no seam — see ProfileDataRepository's
      // createSectionRecordWithId doc comment) — first PATCH creates it
      // with the caller as its own assignee, which is exactly the "own
      // item" precondition this route requires.
      const created = await this.repo.createSectionRecordWithId(
        id,
        req.actorId,
        's14',
        { assigneeId: req.actorId, title: '', status: 'open' },
        req.actorId,
      );
      record = {
        id: created.id,
        userId: req.actorId,
        section: 's14',
        data: created.data,
      };
    }
    if (!record) throw new NotFoundException();
    const assigneeId = record.data.assigneeId as string;

    const isOwnCompletion =
      req.actorId === assigneeId && body.status === 'completed';
    if (isOwnCompletion) {
      const level = await this.accessControl.canAccessSection(
        req.actorId,
        assigneeId,
        's14',
      );
      if (level === 'none') throw new NotFoundException();
      if (await this.accessControl.isDeparted(assigneeId)) {
        throw new ForbiddenException();
      }
    } else {
      await assertSectionWrite(
        this.accessControl,
        req.actorId,
        assigneeId,
        's14',
      );
    }

    const completedAt =
      body.status === 'completed' ? new Date().toISOString() : undefined;
    const updated = await this.repo.updateSectionRecordData(id, {
      ...record.data,
      status: body.status ?? record.data.status,
      ...(completedAt ? { completedAt } : {}),
    });
    return { id: updated.id, ...updated.data };
  }
}
