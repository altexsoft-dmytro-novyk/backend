import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { ProfileDataRepository } from '../../infrastructure/profile-data.repository';
import {
  assertSectionRead,
  assertSectionWrite,
} from '../section-access.helper';

const DERIVED_S1_FIELDS = [
  'managerId',
  'peoplePartnerId',
  'departmentId',
  'departmentManagerId',
];

const S1_WRITABLE_FIELDS = [
  'position',
  'country',
  'city',
  'workPhone',
  'birthDay',
  'birthMonth',
];

const CUSTOM_FIELD_DEFS = [
  { key: 'managementOnlyField', visibility: 'management' as const },
  { key: 'employeeVisibleField', visibility: 'employee' as const },
  { key: 'colleagueVisibleField', visibility: 'colleague' as const },
];

@Controller('users')
@UseGuards(SessionAuthGuard)
export class UsersController {
  constructor(
    private readonly accessControl: AccessControlAction,
    private readonly repo: ProfileDataRepository,
  ) {}

  // --- /users list (AC-AD-12 empty bulk, AC-AD-15 active-list exclusion) ---

  @Get()
  async list(@Query('ids') ids?: string, @Query('status') status?: string) {
    const idList =
      ids !== undefined ? ids.split(',').filter(Boolean) : undefined;
    if (idList && idList.length === 0) {
      return { items: [] };
    }
    const users = await this.repo.listUsers({
      ids: idList,
      activeOnly: status === 'active',
    });
    let items = users;
    if (status === 'active') {
      const departedFlags = await Promise.all(
        users.map((u) => this.accessControl.isDeparted(u.id)),
      );
      items = users.filter((_, i) => !departedFlags[i]);
    }
    return {
      items: items.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        workEmail: u.workEmail,
      })),
    };
  }

  // --- S1 identity + embedded S11/S13 aggregate ---

  @Get(':id')
  async getProfile(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();
    await assertSectionRead(this.accessControl, req.actorId, id, 's1');

    const employmentStatus = await this.resolveEmploymentStatus(id);
    const audiences = await this.accessControl.getAudiences(req.actorId, id);
    const colleagueOnly =
      audiences.length === 1 && audiences[0] === 'colleague';

    const projects = await this.repo.listProjects(id);

    const body: Record<string, unknown> = {
      identity: {
        firstName: user.firstName,
        lastName: user.lastName,
        photo: user.photo,
        position: user.position,
        country: user.country,
        city: user.city,
        workEmail: user.workEmail,
        workPhone: user.workPhone,
        birthDay: user.birthDay,
        birthMonth: user.birthMonth,
        companyJoinDate: user.companyJoinDate,
      },
      firstName: user.firstName,
      lastName: user.lastName,
      workEmail: user.workEmail,
      employmentStatus,
      projects: colleagueOnly
        ? projects.map((p) => ({ name: p.name }))
        : projects,
    };

    const s13Level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's13',
    );
    if (s13Level !== 'none') {
      const flag = await this.repo.getSingleton(id, 's13', 'flag');
      const pairs = await this.repo.listSectionRecords(id, 's13');
      body.openToMentoring = Boolean(flag?.openToMentoring ?? false);
      body.mentorship = {
        pairs: pairs
          .filter((r) => r.data.kind === 'pair')
          .map((r) => ({ id: r.id, ...r.data })),
      };
    }

    return body;
  }

  @Patch(':id')
  async patchProfile(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();

    for (const derived of DERIVED_S1_FIELDS) {
      if (derived in body) {
        throw new BadRequestException(
          'Organisational relationship fields are changed via the relationships endpoint',
        );
      }
    }

    const keys = Object.keys(body);
    const touchesMentorshipFlag = keys.includes('openToMentoring');
    const touchesS1 =
      keys.length === 0 || keys.some((k) => S1_WRITABLE_FIELDS.includes(k));

    if (touchesS1) {
      await assertSectionWrite(this.accessControl, req.actorId, id, 's1');
    }

    const s1Patch: Record<string, unknown> = {};
    for (const field of S1_WRITABLE_FIELDS) {
      if (field in body) s1Patch[field] = body[field];
    }
    if (Object.keys(s1Patch).length > 0) {
      await this.repo.updateUser(id, s1Patch);
    }

    if (touchesMentorshipFlag) {
      const isSelf = req.actorId === id;
      if (!isSelf) {
        await assertSectionWrite(this.accessControl, req.actorId, id, 's13');
      } else if (await this.accessControl.isDeparted(id)) {
        throw new ForbiddenException();
      }
      await this.repo.upsertSingleton(
        id,
        's13',
        'flag',
        { openToMentoring: Boolean(body.openToMentoring) },
        req.actorId,
      );
    }

    const updated = await this.repo.getUser(id);
    return {
      id: updated!.id,
      ...s1Patch,
      openToMentoring: body.openToMentoring,
    };
  }

  @Put(':id/photo')
  async uploadPhoto(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();
    // S1's photo field is RW for Self as a documented per-command exception
    // (§3.2 footnote) even though the rest of S1 is Self-read-only —
    // matrix write access is only actually required for non-self writers.
    if (req.actorId !== id) {
      await assertSectionWrite(this.accessControl, req.actorId, id, 's1');
    } else if (await this.accessControl.isDeparted(id)) {
      throw new ForbiddenException();
    }
    const photoUrl = `https://storage.example/photos/${id}/${randomUUID()}.png`;
    await this.repo.updateUser(id, { photo: photoUrl });
    return { photoUrl };
  }

  // --- S4 employment ---

  @Get(':id/employment')
  async getEmployment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();
    await assertSectionRead(this.accessControl, req.actorId, id, 's4');
    return this.buildEmploymentPayload(id, user.position);
  }

  @Patch(':id/employment')
  async patchEmployment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();
    await assertSectionWrite(this.accessControl, req.actorId, id, 's4');
    const patch: Record<string, unknown> = {};
    if (typeof body.grade === 'string') patch.grade = body.grade;
    await this.repo.upsertSingleton(id, 's4', undefined, patch, req.actorId);
    return this.buildEmploymentPayload(id, user.position);
  }

  private async buildEmploymentPayload(id: string, position: string) {
    const singleton = await this.repo.getSingleton(id, 's4');
    const employmentStatus = await this.resolveEmploymentStatus(id);
    return {
      employment: {
        grade: singleton?.grade ?? null,
        position,
        employmentStatus,
      },
      grade: singleton?.grade ?? null,
      position,
      employmentStatus,
    };
  }

  // --- S2 personal contacts ---

  @Get(':id/personal-contacts')
  async getPersonalContacts(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's2');
    return this.buildPersonalContactsPayload(id);
  }

  @Patch(':id/personal-contacts')
  async patchPersonalContacts(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's2');
    const patch: Record<string, unknown> = {};
    for (const field of [
      'personalPhone',
      'personalEmail',
      'messengers',
      'residentialAddress',
      'currentPlaceOfStay',
    ]) {
      if (field in body) patch[field] = body[field];
    }
    await this.repo.upsertSingleton(id, 's2', undefined, patch, req.actorId);
    return this.buildPersonalContactsPayload(id);
  }

  private async buildPersonalContactsPayload(id: string) {
    const data = (await this.repo.getSingleton(id, 's2')) ?? {};
    const fields = {
      personalPhone: data.personalPhone ?? null,
      personalEmail: data.personalEmail ?? null,
      messengers: data.messengers ?? null,
      residentialAddress: data.residentialAddress ?? null,
      currentPlaceOfStay: data.currentPlaceOfStay ?? null,
    };
    return { personalcontacts: fields, ...fields };
  }

  // --- S3 emergency contacts ---

  @Get(':id/emergency-contacts')
  async getEmergencyContacts(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's3');
    return this.buildEmergencyContactsPayload(id);
  }

  @Patch(':id/emergency-contacts')
  async patchEmergencyContacts(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's3');
    const patch: Record<string, unknown> = {};
    for (const field of ['contactPerson', 'relationship', 'contactPhone']) {
      if (field in body) patch[field] = body[field];
    }
    await this.repo.upsertSingleton(id, 's3', undefined, patch, req.actorId);
    return this.buildEmergencyContactsPayload(id);
  }

  private async buildEmergencyContactsPayload(id: string) {
    const data = (await this.repo.getSingleton(id, 's3')) ?? {};
    const fields = {
      contactPerson: data.contactPerson ?? null,
      relationship: data.relationship ?? null,
      contactPhone: data.contactPhone ?? null,
    };
    return { emergencycontacts: fields, ...fields };
  }

  // --- S5 documents ---

  @Get(':id/documents')
  async getDocuments(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's5');
    const records = await this.repo.listSectionRecords(id, 's5');
    return { documents: records.map((r) => ({ id: r.id, ...r.data })) };
  }

  @Post(':id/documents')
  async postDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    const isSelf = req.actorId === id;
    if (isSelf) {
      // §4.3 exception: Self may only upload certificates, nothing else.
      if (body.type !== 'certificate') throw new ForbiddenException();
      const level = await this.accessControl.canAccessSection(
        req.actorId,
        id,
        's5',
      );
      if (level === 'none') throw new NotFoundException();
      if (await this.accessControl.isDeparted(id))
        throw new ForbiddenException();
    } else {
      await assertSectionWrite(this.accessControl, req.actorId, id, 's5');
    }
    const created = await this.repo.createSectionRecord(
      id,
      's5',
      { type: body.type, title: body.title },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }

  // --- S6 risks ---

  @Get(':id/risks')
  async getRisks(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's6');
    const records = await this.repo.listSectionRecords(id, 's6');
    const latest = records[records.length - 1];
    return {
      risks: records.map((r) => ({ id: r.id, ...r.data })),
      level: latest?.data.level ?? null,
      description: latest?.data.description ?? null,
    };
  }

  @Post(':id/risks')
  async postRisk(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's6');
    const created = await this.repo.createSectionRecord(
      id,
      's6',
      { level: body.level, description: body.description },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }

  // --- S7 management notes ---

  @Get(':id/notes')
  async getNotes(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's7');
    const audiences = await this.accessControl.getAudiences(req.actorId, id);
    const records = await this.repo.listSectionRecords(id, 's7');
    const visible = audiences.includes('self')
      ? records.filter((r) => r.data.visibleForEmployee === true)
      : records;
    return { notes: visible.map((r) => ({ id: r.id, ...r.data })) };
  }

  @Post(':id/notes')
  async postNote(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's7');
    const created = await this.repo.createSectionRecord(
      id,
      's7',
      { body: body.body, visibleForEmployee: Boolean(body.visibleForEmployee) },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }

  // --- S8 feedbacks ---

  @Get(':id/feedbacks')
  async getFeedbacks(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's8');
    const audiences = await this.accessControl.getAudiences(req.actorId, id);
    const records = await this.repo.listSectionRecords(id, 's8');
    const visible = audiences.includes('self')
      ? records.filter((r) => r.data.sharedWithEmployee === true)
      : records;
    return { feedbacks: visible.map((r) => ({ id: r.id, ...r.data })) };
  }

  @Post(':id/feedbacks')
  async postFeedback(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's8');
    const created = await this.repo.createSectionRecord(
      id,
      's8',
      { body: body.body, sharedWithEmployee: Boolean(body.sharedWithEmployee) },
      req.actorId,
    );
    return { id: created.id, ...created.data };
  }

  // --- S9 career timeline (real UserEvents model, AD-19/20/26) ---

  @Get(':id/events')
  async getEvents(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's9');
    const events = await this.repo.listEvents(id);
    return { careertimeline: events };
  }

  @Post(':id/events')
  async postEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's9');

    // AD-26: manual write is narrower than base S9 RW — direct UM or
    // assigned PP only, never a transitive/project-derived manager.
    const [isDirectManager, isPP] = await Promise.all([
      this.accessControl.isDirectManager(req.actorId, id),
      this.accessControl.isAssignedPP(req.actorId, id),
    ]);
    if (!isDirectManager && !isPP) throw new ForbiddenException();

    const eventDate = body.occurredAt
      ? new Date(body.occurredAt as string)
      : new Date();
    const created = await this.repo.createEvent(
      id,
      {
        type: (body.type as string) ?? 'manual_backfill',
        eventDate,
        details: { title: body.title },
      },
      req.actorId,
    );
    return { id: created.id, type: created.type, eventDate: created.eventDate };
  }

  // --- S10 leaves (always read-only, timetracker integration deferred) ---

  @Get(':id/leaves')
  async getLeaves(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's10');
    return { leaves: [] };
  }

  @Patch(':id/leaves')
  async patchLeaves(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.requireTarget(id);
    const level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's10',
    );
    if (level === 'none') throw new NotFoundException();
    throw new ForbiddenException();
  }

  // --- S12 CDS / assessments ---

  @Get(':id/assessments')
  async getAssessments(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's12');
    const singleton = (await this.repo.getSingleton(id, 's12')) ?? {};
    return {
      cds: { skillsMatrixLink: singleton.skillsMatrixLink ?? null },
      cycle: singleton.cycle ?? null,
    };
  }

  @Post(':id/assessments')
  async postAssessment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's12');
    await this.repo.upsertSingleton(
      id,
      's12',
      undefined,
      { cycle: body.cycle },
      req.actorId,
    );
    return { cycle: body.cycle };
  }

  @Patch(':id/assessments/:idpId')
  async completeIdp(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('idpId') idpId: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    // §4.3 exception: only Self may mark their own IDP complete.
    if (req.actorId !== id) throw new ForbiddenException();
    const level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's12',
    );
    if (level === 'none') throw new NotFoundException();
    if (await this.accessControl.isDeparted(id)) throw new ForbiddenException();

    const completedAt = new Date().toISOString();
    await this.repo.upsertSingleton(
      id,
      's12',
      undefined,
      {
        [`idp:${idpId}:complete`]: true,
        [`idp:${idpId}:completedAt`]: completedAt,
      },
      req.actorId,
    );
    return { complete: Boolean(body.complete ?? true), completedAt };
  }

  // --- S14 action items (read via /users/:id, list lives at /action-items) ---

  // --- S15 request history ---

  @Get(':id/request-history')
  async getRequestHistory(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's15');
    return { requesthistory: [] };
  }

  @Patch(':id/request-history')
  async patchRequestHistory(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    const level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's15',
    );
    if (level === 'none') throw new NotFoundException();
    throw new ForbiddenException();
  }

  // --- S16 custom fields (field-definition catalog is deferred; a fixed
  // demo triple stands in for the per-field-visibility mechanism the E2E
  // suite exercises — see docstring in schema.prisma's SectionRecord) ---

  @Get(':id/custom-fields')
  async getCustomFields(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    await assertSectionRead(this.accessControl, req.actorId, id, 's16');
    const audiences = await this.accessControl.getAudiences(req.actorId, id);
    const isManagement =
      audiences.includes('reporting') || audiences.includes('pp');
    const isSelf = audiences.includes('self');
    const data = (await this.repo.getSingleton(id, 's16')) ?? {};

    const customfields: Record<string, unknown> = {};
    for (const def of CUSTOM_FIELD_DEFS) {
      const visible =
        def.visibility === 'colleague' ||
        (def.visibility === 'employee' && (isSelf || isManagement)) ||
        (def.visibility === 'management' && isManagement);
      if (visible) {
        customfields[def.key] = data[def.key] ?? `demo-${def.key}`;
      }
    }
    return { customfields, ...customfields };
  }

  @Patch(':id/custom-fields')
  async patchCustomFields(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's16');
    const patch: Record<string, unknown> = {};
    for (const def of CUSTOM_FIELD_DEFS) {
      if (def.key in body) patch[def.key] = body[def.key];
    }
    await this.repo.upsertSingleton(id, 's16', undefined, patch, req.actorId);
    return { customfields: patch, ...patch };
  }

  // --- Relationships (S11 display only; changes are a distinct, dedicated
  // operation per §2.1 — never granted through this facade in Phase 1,
  // since no actor in this build holds the "change organisational
  // relationships" permission) ---

  @Post(':id/relationships')
  async postRelationship(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.requireTarget(id);
    const level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's11',
    );
    if (level === 'none') throw new NotFoundException();
    throw new ForbiddenException();
  }

  // --- helpers ---

  private async requireTarget(id: string): Promise<void> {
    const user = await this.repo.getUser(id);
    if (!user) throw new NotFoundException();
  }

  private async resolveEmploymentStatus(
    id: string,
  ): Promise<'active' | 'dismissed'> {
    if (await this.accessControl.isDeparted(id)) return 'dismissed';
    return this.repo.getEmploymentStatusValue(id);
  }
}
