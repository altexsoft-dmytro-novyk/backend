import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { SessionAuthGuard } from '../../../access-control/application/guards/session-auth.guard';
import type { AuthenticatedRequest } from '../../../access-control/application/guards/session-auth.guard';
import { Prisma } from '../../../generated/prisma/client';
import { StoreObjectAction } from '../../../storage/application/actions/store-object.action';
import {
  DeparturePendingError,
  DepartureService,
  StillManagingError,
  TargetNotFoundError,
} from '../../domain/services/departure.service';
import { SelfAssignmentError } from '../../domain/services/relationship-write.service';
import { RelationshipWriteService } from '../../domain/services/relationship-write.service';
import { ProfileDataRepository } from '../../infrastructure/profile-data.repository';
import {
  assertSectionRead,
  assertSectionWrite,
} from '../section-access.helper';

// Epic 4/AD-25: the four organisational-relationship fields a
// "change organisational relationships" holder may change through this one
// dedicated endpoint, never through the general S1 PATCH.
const RELATIONSHIP_FIELDS = [
  'manager',
  'people_partner',
  'department',
] as const;
type RelationshipField = (typeof RELATIONSHIP_FIELDS)[number];

const DERIVED_S1_FIELDS = [
  'managerId',
  'peoplePartnerId',
  'departmentId',
  'departmentManagerId',
];

// FR-9: identity-card fields Manager/PP/reporting-line writers may change
// through the plain S1 PATCH. workEmail is included per FR-7 ("workEmail
// and ttId are unique ... on authorized identity updates") and um-pf-03 —
// its uniqueness violation is caught below and mapped to 409, never a
// silent no-op.
const S1_WRITABLE_FIELDS = [
  'position',
  'country',
  'city',
  'workPhone',
  'birthDay',
  'birthMonth',
  'workEmail',
];

// S1 profile photo (§3.2 footnote): accepted image types mapped to the file
// extension used in the storage key, and the upload size ceiling enforced by
// multer (a larger body is rejected as 413 before it buffers).
const PHOTO_MIME_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

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
    private readonly relationshipWrite: RelationshipWriteService,
    private readonly departure: DepartureService,
    private readonly storeObject: StoreObjectAction,
  ) {}

  // --- /users list (AC-AD-12 empty bulk, AC-AD-15 active-list exclusion) ---

  // Story 1.5 (FR-15/FR-16): paginated, filtered public listing. `status`
  // (legacy) and the new `employmentStatus` filter are both accepted —
  // AC-AD-12/AC-AD-15 (access-control's own 181-test suite) already depend
  // on `?ids=` (empty-list fast path) and `?status=active`; both keep their
  // exact prior shape/behavior. `ttId`/`isActive` are deliberately never
  // filterable — see ProfileDataRepository.listUsersPage's doc comment.
  @Get()
  async list(
    @Query('ids') ids?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('employmentStatus') employmentStatus?: string,
    @Query('country') country?: string,
    @Query('city') city?: string,
    @Query('position') position?: string,
    @Query('firstName') firstName?: string,
    @Query('lastName') lastName?: string,
    @Query('workEmail') workEmail?: string,
    @Query('workPhone') workPhone?: string,
    @Query('companyJoinDate') companyJoinDate?: string,
    @Query('birthDay') birthDay?: string,
    @Query('birthMonth') birthMonth?: string,
  ) {
    const idList =
      ids !== undefined ? ids.split(',').filter(Boolean) : undefined;
    if (idList && idList.length === 0) {
      return { items: [] };
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50));

    const filters: Record<string, string | number | Date | undefined> = {
      country,
      city,
      position,
      firstName,
      lastName,
      workEmail,
      workPhone,
      birthDay: birthDay !== undefined ? Number(birthDay) : undefined,
      birthMonth: birthMonth !== undefined ? Number(birthMonth) : undefined,
      // companyJoinDate is a @db.Date column — Prisma needs the parsed
      // Date, not the raw query string, for an exact-day equality filter.
      companyJoinDate: companyJoinDate ? new Date(companyJoinDate) : undefined,
    };

    const { items: candidates, total } = await this.repo.listUsersPage({
      ids: idList,
      filters,
      skip: (pageNum - 1) * pageSizeNum,
      take: pageSizeNum,
    });

    const statusMap = await this.repo.resolveEmploymentStatuses(
      candidates.map((u) => u.id),
    );
    const wantDismissed = employmentStatus === 'dismissed';
    // Default behavior (no explicit filter, or the legacy `status=active`)
    // excludes dismissed employees from the default view — findable only
    // through the explicit filter (Story 1.5 AC / um-list-05).
    const excludeDismissed = !wantDismissed;

    const items = candidates.filter((u) => {
      const effective = statusMap.get(u.id) ?? 'active';
      if (wantDismissed) return effective === 'dismissed';
      if (excludeDismissed) return effective !== 'dismissed';
      return true;
    });

    // Note: `total` is the DB-level count matching the field filters only —
    // the employment-status default-exclusion is applied to this page's
    // rows in application code (bulk-resolved, not a per-row query), so a
    // page can return fewer than `pageSize` items even when more field-
    // matching rows exist beyond it. Pushing this into one DB-level query
    // would need a materialized/computed status column; out of this
    // story's scope to add speculatively.
    return {
      items: items.map((u) => ({
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        workEmail: u.workEmail,
        position: u.position,
        country: u.country,
        city: u.city,
        workPhone: u.workPhone,
        birthDay: u.birthDay,
        birthMonth: u.birthMonth,
        companyJoinDate: u.companyJoinDate,
        employmentStatus: statusMap.get(u.id) ?? 'active',
      })),
      total,
      page: pageNum,
      pageSize: pageSizeNum,
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

    // Identity fields are exposed both nested (`identity`, the shape the
    // access-control matrix suite's 181 E2E tests were written against) and
    // flattened at the top level (um-seed-01 reads position/country/city/
    // workPhone/birthDay/birthMonth/companyJoinDate directly off the root
    // body) — additive, no key collisions between the two.
    const identity = {
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
    };

    // §4.2: the profile header shows the person's department, manager and
    // people partner. Read-only, resolved alongside S1 (which every audience
    // including colleague may read), so no new leak surface.
    const relations = await this.repo.getProfileHeaderRelations(id);

    // §3.3.5: the viewer's own none/read/write level for every section, so the
    // client renders exactly the sections they may see and shows an edit
    // affordance only where they may write — never a dead button, never a
    // section fetched only to 404. This is the same live `canAccessSection`
    // decision each section endpoint already enforces, surfaced once up front.
    const SECTION_IDS = [
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      's13',
      's14',
      's15',
      's16',
    ] as const;
    const levels = await Promise.all(
      SECTION_IDS.map((section) =>
        this.accessControl.canAccessSection(req.actorId, id, section),
      ),
    );
    const access = Object.fromEntries(
      SECTION_IDS.map((section, i) => [section, levels[i]]),
    ) as Record<(typeof SECTION_IDS)[number], 'none' | 'read' | 'write'>;

    const body: Record<string, unknown> = {
      identity,
      ...identity,
      employmentStatus,
      access,
      department: relations.department,
      manager: relations.manager,
      peoplePartner: relations.peoplePartner,
      mentor: null,
      projects: colleagueOnly
        ? projects.map((p) => ({ name: p.name }))
        : projects,
    };

    const s13Level = access.s13;
    if (s13Level !== 'none') {
      const flag = await this.repo.getSingleton(id, 's13', 'flag');
      const pairs = await this.repo.listSectionRecords(id, 's13');
      body.openToMentoring = Boolean(flag?.openToMentoring ?? false);
      body.mentorship = {
        pairs: pairs
          .filter((r) => r.data.kind === 'pair')
          .map((r) => ({ id: r.id, ...r.data })),
      };

      // §4.11: the mentor is the holder of an active pair where this person
      // is the mentee. Only resolvable when the viewer can see S13 at all.
      const mentorPair = pairs.find(
        (r) =>
          r.data.kind === 'pair' &&
          r.data.menteeId === id &&
          (r.data.status ?? 'active') === 'active',
      );
      if (mentorPair) {
        body.mentor = await this.repo.getUserName(
          mentorPair.data.mentorId as string,
        );
      }
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
      try {
        await this.repo.updateUserTrackingPositionChange(
          id,
          s1Patch,
          req.actorId,
        );
      } catch (err) {
        // um-pf-03/FR-7: a unique-constraint violation on workEmail/ttId is
        // a 409, not a silent no-op or a 500 — Alice's row is left
        // unchanged since Prisma's update never applied.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          throw new ConflictException();
        }
        throw err;
      }
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
  @UseInterceptors(
    FileInterceptor('photo', { limits: { fileSize: MAX_PHOTO_BYTES } }),
  )
  async uploadPhoto(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
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

    if (!file) throw new BadRequestException('a "photo" file part is required');
    const ext = PHOTO_MIME_TYPES[file.mimetype];
    if (!ext) {
      throw new BadRequestException('photo must be a PNG, JPEG or WebP image');
    }

    // Store the bytes through storage/'s single cross-context entry point
    // (AD-2) and persist only the reference it returns.
    const key = `photos/${id}/${randomUUID()}.${ext}`;
    const photoUrl = await this.storeObject.execute(
      key,
      file.buffer,
      file.mimetype,
    );
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

    // um-ct-03/05: the manual-add scenarios send `eventDate` and `details`
    // directly (the matrix E2E suite's own probes send the older
    // `occurredAt`/`title` shape instead) — accept either so both call
    // sites keep working.
    const eventDate = body.eventDate
      ? new Date(body.eventDate as string)
      : body.occurredAt
        ? new Date(body.occurredAt as string)
        : new Date();
    const details =
      (body.details as Record<string, unknown> | undefined) ??
      (body.title !== undefined ? { title: body.title } : {});
    const created = await this.repo.createEvent(
      id,
      {
        type: (body.type as string) ?? 'manual_backfill',
        eventDate,
        details,
      },
      req.actorId,
    );
    return {
      id: created.id,
      type: created.type,
      source: created.source,
      eventDate: created.eventDate,
      details: created.details,
    };
  }

  // AD-20: manual delete is a soft-delete (deletedAt), never a hard delete
  // — the row stays reconstructable, just excluded from listEvents' active
  // read. Same AD-26 narrowing as the manual add above (direct UM/assigned
  // PP only).
  @Delete(':id/events/:eventId')
  async deleteEvent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
  ) {
    await this.requireTarget(id);
    await assertSectionWrite(this.accessControl, req.actorId, id, 's9');

    const [isDirectManager, isPP] = await Promise.all([
      this.accessControl.isDirectManager(req.actorId, id),
      this.accessControl.isAssignedPP(req.actorId, id),
    ]);
    if (!isDirectManager && !isPP) throw new ForbiddenException();

    const event = await this.repo.findEvent(id, eventId);
    if (!event) throw new NotFoundException();

    await this.repo.softDeleteEvent(eventId);
    return { id: eventId };
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
  // operation per §2.1/AD-25, gated on the "change organisational
  // relationships" functional permission — never through the general S1
  // PATCH, and independent of S11's own read/write matrix cell). Epic 4:
  // Stories 4.1 (manager), 4.2 (People Partner), 4.3 (department; the
  // department-manager half of 4.3 lives at
  // POST /departments/:id/manager since its subject is a department, not
  // this user). ---

  @Post(':id/relationships')
  async postRelationship(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.requireTarget(id);

    // AD-23 leak-safety ordering, preserved from this endpoint's original
    // stub: a no-S11-access actor gets 404 before anything else, an actor
    // who can at least see S11 but lacks the dedicated permission gets 403
    // — both independent of whatever the request body contains, so an
    // unauthorized caller never learns the accepted body shape.
    const s11Level = await this.accessControl.canAccessSection(
      req.actorId,
      id,
      's11',
    );
    if (s11Level === 'none') throw new NotFoundException();

    // AD-9/CAP-3: a distinct functional permission from S11's matrix
    // read/write cell — holding S11 write access (e.g. as Bob, Alice's
    // direct manager) does NOT by itself authorize changing the edge
    // itself; only an explicit "change organisational relationships"
    // Policy attachment does.
    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'change organisational relationships',
    );
    if (!allowed) throw new ForbiddenException();

    const field = body.field as RelationshipField | undefined;
    if (!field || !RELATIONSHIP_FIELDS.includes(field)) {
      throw new BadRequestException(
        'field must be one of ' + RELATIONSHIP_FIELDS.join(', '),
      );
    }
    const value = (body.value as string | null | undefined) ?? null;
    const expectedCurrent =
      'expectedCurrent' in body
        ? (body.expectedCurrent as string | null)
        : undefined;

    if (value !== null) {
      const exists =
        field === 'department'
          ? await this.relationshipWrite.departmentExists(value)
          : await this.relationshipWrite.userExists(value);
      if (!exists) throw new NotFoundException();
    }

    try {
      const result = await (() => {
        switch (field) {
          case 'manager':
            return this.relationshipWrite.changeManager(
              req.actorId,
              id,
              value,
              expectedCurrent,
            );
          case 'people_partner':
            return this.relationshipWrite.changePeoplePartner(
              req.actorId,
              id,
              value,
              expectedCurrent,
            );
          case 'department':
            if (value === null) {
              throw new BadRequestException(
                'department cannot be cleared to null',
              );
            }
            return this.relationshipWrite.changeDepartment(
              req.actorId,
              id,
              value,
              expectedCurrent,
            );
        }
      })();

      if (result.outcome === 'conflict') throw new ConflictException();
      if (result.outcome === 'not_found') throw new NotFoundException();
      return { field, value: result.value };
    } catch (err) {
      if (err instanceof SelfAssignmentError) throw new ForbiddenException();
      throw err;
    }
  }

  // --- Departure (Epic 5, AD-15) ---

  @Post(':id/departure')
  async postDeparture(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const allowed = await this.accessControl.isAllowed(
      req.actorId,
      'record a departure',
    );
    if (!allowed) throw new ForbiddenException();

    const effectiveDate = new Date(body.effectiveDate as string);
    if (Number.isNaN(effectiveDate.getTime())) {
      throw new BadRequestException('effectiveDate must be a valid date');
    }
    const reason = typeof body.reason === 'string' ? body.reason : '';

    try {
      const created = await this.departure.recordDeparture(
        id,
        effectiveDate,
        reason,
        req.actorId,
      );
      return {
        id: created.id,
        userId: created.userId,
        effectiveDate: created.effectiveDate,
        reason: created.reason,
        appliedAt: created.appliedAt,
      };
    } catch (err) {
      if (err instanceof TargetNotFoundError) throw new NotFoundException();
      if (err instanceof StillManagingError) throw new ConflictException();
      if (err instanceof DeparturePendingError) throw new ConflictException();
      throw err;
    }
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
