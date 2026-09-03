import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AddDepartmentMembershipAction } from '../actions/add-department-membership.action';
import type { DepartmentMembershipResponse } from '../actions/add-department-membership.action';
import { AssignManagerAction } from '../actions/assign-manager.action';
import { ChangePeoplePartnerAction } from '../actions/change-people-partner.action';
import { GetAccessJournalAction } from '../actions/get-access-journal.action';
import { RemoveDepartmentMembershipAction } from '../actions/remove-department-membership.action';
import { RemovePeoplePartnerAction } from '../actions/remove-people-partner.action';
import { RevokeManagerAction } from '../actions/revoke-manager.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import { RequireFeature } from '../decorators/require-feature.decorator';
import { AddDepartmentMembershipDto } from '../dtos/add-department-membership.dto';
import { CreateRelationshipDto } from '../dtos/create-relationship.dto';
import { PeoplePartnerQueryDto } from '../dtos/people-partner-query.dto';
import { UpdatePeoplePartnerDto } from '../dtos/update-people-partner.dto';
import type { AccessJournalEnvelope } from '../dtos/access-journal.response';
import type { RelationshipResponse } from '../dtos/relationship.response';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SessionGuard } from '../guards/session.guard';
import type { Session } from '../../domain/interfaces/session-resolver.port';

// Epic 4 Story 4.1 — the dedicated organisational-relationship screen's HTTP
// surface (AD-14 shape 4), kept out of `users.controller.ts` to stop it
// bloating. A second `@Controller('users')` is fine — NestJS allows many.
//
// The two write routes carry the dedicated `org:relationships:write` capability
// (no-target `isAllowed` through the facade — DEC-UM-002, never a
// `User.position` / role-name check); `AccessControlGuard` enforces it from the
// `@RequireFeature` metadata. The journal read route has NO `@RequireFeature`:
// its §3.4 reader gate (current Reporting-line manager or assigned PP only) is
// enforced inside the action. `SessionGuard` produces every `401`.
const ORG_RELATIONSHIPS_WRITE_FEATURE = 'org:relationships:write';

@Controller('users')
@UseGuards(SessionGuard, AccessControlGuard)
export class RelationshipsController {
  constructor(
    private readonly assignManagerAction: AssignManagerAction,
    private readonly revokeManagerAction: RevokeManagerAction,
    private readonly changePeoplePartnerAction: ChangePeoplePartnerAction,
    private readonly removePeoplePartnerAction: RemovePeoplePartnerAction,
    private readonly getAccessJournalAction: GetAccessJournalAction,
    private readonly addDepartmentMembershipAction: AddDepartmentMembershipAction,
    private readonly removeDepartmentMembershipAction: RemoveDepartmentMembershipAction,
  ) {}

  // Nest returns 201 for a POST by default; the body is the bare created edge,
  // not a `{ data }` envelope.
  @Post(':id/relationships')
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async createRelationship(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: CreateRelationshipDto,
  ): Promise<RelationshipResponse> {
    return this.assignManagerAction.execute(session.userId, id, dto);
  }

  // --- Story 4.2 — the fixed-cardinality `people_partner` edge --------------
  // The static `people-partner` segment MUST be declared BEFORE the generic
  // `@Delete(':id/relationships/:relationshipId')` below, or Nest matches
  // `people-partner` as a `:relationshipId` param (Express registers routes in
  // declaration order).

  // Create-or-atomically-replace. `PUT` defaults to `200` in Nest; the body is
  // the bare edge `{ id, userId, type, reportsToUserId }` for both create and
  // replace (not a `{ data }` envelope).
  @Put(':id/relationships/people-partner')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async changePeoplePartner(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: UpdatePeoplePartnerDto,
  ): Promise<RelationshipResponse> {
    return this.changePeoplePartnerAction.execute(session.userId, id, dto);
  }

  // Hard delete + one same-transaction journal row (`after: null`). `200` with
  // an empty body. Optional `?expectedCurrentTargetId=` conditional guard.
  @Delete(':id/relationships/people-partner')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async removePeoplePartner(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: PeoplePartnerQueryDto,
  ): Promise<void> {
    await this.removePeoplePartnerAction.execute(session.userId, id, query);
  }

  // Hard delete (AD-11 — no `deletedAt`/`isActive`). 200 with an empty body;
  // um-rel-02 asserts the status only.
  @Delete(':id/relationships/:relationshipId')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async deleteRelationship(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('relationshipId') relationshipId: string,
  ): Promise<void> {
    await this.revokeManagerAction.execute(session.userId, id, relationshipId);
  }

  // --- Story 4.3 — department membership (an owned temporal set) ------------
  // `POST` with `fromDepartmentId` = atomic named-source move; without it =
  // plain add. Nest returns `201` for a `POST`; the body is the bare created
  // membership.
  @Post(':id/departments')
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async addDepartmentMembership(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: AddDepartmentMembershipDto,
  ): Promise<DepartmentMembershipResponse> {
    return this.addDepartmentMembershipAction.execute(session.userId, id, dto);
  }

  // Close the current membership row (`validTo = today` — never a hard delete).
  // `200` with an empty body. Non-membership → `404`; last membership → `409`.
  @Delete(':id/departments/:departmentId')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(ORG_RELATIONSHIPS_WRITE_FEATURE)
  async removeDepartmentMembership(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('departmentId') departmentId: string,
  ): Promise<void> {
    await this.removeDepartmentMembershipAction.execute(
      session.userId,
      id,
      departmentId,
    );
  }

  // No `@RequireFeature` — the §3.4 reader gate is inside the action. Distinct
  // path from `:id` (`:id/access-journal` never collides). `AccessJournal` is
  // append-only: there is deliberately no PATCH/PUT/DELETE sibling (um-rel-15 T1).
  @Get(':id/access-journal')
  async findAccessJournal(
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ): Promise<AccessJournalEnvelope> {
    return this.getAccessJournalAction.execute(session.userId, id);
  }
}
