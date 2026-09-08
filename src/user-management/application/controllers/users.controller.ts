import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import type { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { AddManualUserEventAction } from '../actions/add-manual-user-event.action';
import { DeactivateUserAction } from '../actions/deactivate-user.action';
import { EditUserAction } from '../actions/edit-user.action';
import { GetUserCardAction } from '../actions/get-user-card.action';
import { GetUserEventsAction } from '../actions/get-user-events.action';
import { ImportPopulationAction } from '../actions/import-population.action';
import { ListUsersAction } from '../actions/list-users.action';
import { SoftDeleteUserEventAction } from '../actions/soft-delete-user-event.action';
import { UploadUserPhotoAction } from '../actions/upload-user-photo.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import { RequireFeature } from '../decorators/require-feature.decorator';
import { RequireSectionAccess } from '../decorators/require-section-access.decorator';
import { SelfOnly } from '../decorators/self-only.decorator';
import { ListUsersQueryDto } from '../dtos/list-users-query.dto';
import { CreateUserEventDto } from '../dtos/create-user-event.dto';
import { UpdateUserDto } from '../dtos/update-user.dto';
import { toUserResponse } from '../dtos/user.response';
import {
  toUserListItem,
  type UserListItem,
} from '../dtos/user-list-item.response';
import type { UserCardResponse } from '../dtos/user-card.response';
import type {
  UserEventResponse,
  UserEventsEnvelope,
} from '../dtos/user-event.response';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SectionAccessGuard } from '../guards/section-access.guard';
import { SelfOnlyGuard } from '../guards/self-only.guard';
import { SessionGuard } from '../guards/session.guard';
import { PROFILE_IDENTITY_SECTION } from '../../domain/constants/section-keys';
import type { Session } from '../../domain/interfaces/session-resolver.port';
import { PaginatedResponseDto } from '../../../common/dtos/paginated-response.dto';

// The seeded-population import reuses the existing kernel permission the retired
// `POST /users` required (AD-21 / seed README) — no new `user-management:import`
// key. In the seeded system this key is held only by the HR-Admin root.
const IMPORT_POPULATION_FEATURE = 'user-management:create';
// `user-management:edit` / `user-management:read` are gone from this file:
// PLAT-E4-S4.1c moved `GET`/`PATCH /users/:id` off the per-feature
// target-scoped gate onto `@RequireSectionAccess`. The two constants had no
// remaining reference here, and an unreferenced const is a lint error — the
// dead *adapter* branches that still name those keys are 4.1d's to remove.
const DEACTIVATE_USER_FEATURE = 'user-management:deactivate';
const LIST_USERS_FEATURE = 'user-management:list';

// The only accepted `GET /users` query params (Story 1.5). Anything else is a
// 400 — see findAll. Kept in sync with `ListUsersQueryDto` + `PaginationQueryDto`.
const LIST_QUERY_PARAMS = new Set([
  'page',
  'pageSize',
  'firstName',
  'lastName',
  'position',
  'country',
  'city',
  'workEmail',
  'workPhone',
  'birthDay',
  'birthMonth',
  'companyJoinDate',
  'employmentStatus',
]);

// Story 1.3 photo-upload validation (profile/README decisions 3 & 4):
// a profile avatar, not a document store.
const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const PHOTO_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

@Controller('users')
@UseGuards(SessionGuard, AccessControlGuard, SectionAccessGuard, SelfOnlyGuard)
export class UsersController {
  constructor(
    private readonly editUserAction: EditUserAction,
    private readonly getUserCardAction: GetUserCardAction,
    private readonly uploadUserPhotoAction: UploadUserPhotoAction,
    private readonly deactivateUserAction: DeactivateUserAction,
    private readonly listUsersAction: ListUsersAction,
    private readonly importPopulationAction: ImportPopulationAction,
    private readonly getUserEventsAction: GetUserEventsAction,
    private readonly addManualUserEventAction: AddManualUserEventAction,
    private readonly softDeleteUserEventAction: SoftDeleteUserEventAction,
  ) {}

  @Get()
  @RequireFeature(LIST_USERS_FEATURE)
  async findAll(
    @Query() query: ListUsersQueryDto,
    @Req() req: Request,
  ): Promise<PaginatedResponseDto<UserListItem>> {
    // The global pipe is `whitelist` only — it strips unknown query keys
    // silently. Story 1.5 (um-list-09/11) requires a hard 400 instead: FR-15
    // internal columns (`ttId`, `isActive`, `createdBy`) are never filterable
    // and there is no `sort`/`order` override, so reject anything that is not
    // one of the accepted params before it can be silently ignored.
    const unknownParams = Object.keys(req.query).filter(
      (key) => !LIST_QUERY_PARAMS.has(key),
    );
    if (unknownParams.length > 0) {
      throw new BadRequestException(
        `unsupported query parameter(s): ${unknownParams.join(', ')}`,
      );
    }

    const page = await this.listUsersAction.execute(query);
    return new PaginatedResponseDto(
      page.items.map(toUserListItem),
      page.total,
      page.page,
      page.pageSize,
    );
  }

  // Literal sibling — declared BEFORE `:id` so a `:id` handler never swallows it
  // (`id = 'import'`), per api-conventions.md. There is no `POST /users` create
  // route: the population is a seeded import (AD-16 / AD-21).
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(IMPORT_POPULATION_FEATURE)
  @UseInterceptors(FileInterceptor('file'))
  async importPopulation(
    @CurrentSession() session: Session,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'a multipart "file" part (the semicolon-delimited CSV) is required',
      );
    }
    return this.importPopulationAction.execute(file.buffer, session.userId);
  }

  // Read gate: any non-empty §3.2 audience over an active target reaches at
  // least `read` on `profile:identity`, so `write` (reporting line / People
  // Partner) satisfies it too; an empty audience — a deactivated or unknown
  // target — resolves `none` and denies `403`.
  @Get(':id')
  @RequireSectionAccess(PROFILE_IDENTITY_SECTION, 'read')
  async findOne(
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ): Promise<UserCardResponse> {
    return this.getUserCardAction.execute(session.userId, id);
  }

  // Distinct path from `:id` (`:id/events` never collides with `:id`); declared
  // beside the other `:id` routes. Read gate is INSIDE the action — the
  // career-timeline S9 read audience excludes colleague, so it is NOT
  // `@RequireSectionAccess('profile:identity', 'read')` (that is the
  // identity-card audience). `SessionGuard`
  // produces the `401` for a missing/invalid token.
  @Get(':id/events')
  async findEvents(
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ): Promise<UserEventsEnvelope> {
    return this.getUserEventsAction.execute(session.userId, id);
  }

  // Story 3.2 — manual backfill. Same path family as the GET; write gate is
  // INSIDE the action (`isAllowed(viewer, 'profile:timeline:write')` alone at
  // this stage), so NO `@RequireFeature*`. `SessionGuard` gives the `401`.
  // Nest returns `201` for a POST by default; the body is the bare
  // `UserEventResponse`, not the `{ data, canEdit }` envelope.
  @Post(':id/events')
  async addEvent(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: CreateUserEventDto,
  ): Promise<UserEventResponse> {
    return this.addManualUserEventAction.execute(session.userId, id, dto);
  }

  // Story 3.3 — soft-delete. Same path family as the GET/POST; the delete gate
  // is INSIDE the action (`isAllowed(viewer, 'profile:timeline:write')` alone at
  // this stage), so NO `@RequireFeature*`. `SessionGuard` gives the `401`. No
  // `PATCH` sibling: the immutable-fact model has no in-place edit — a
  // correction is this DELETE plus Story 3.2's POST (um-ct-08 asserts the
  // `PATCH` route stays unbound → `404`).
  @Delete(':id/events/:eventId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEvent(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
  ): Promise<void> {
    await this.softDeleteUserEventAction.execute(session.userId, id, eventId);
  }

  // Write gate: the SCP 2026-09-04 D1 dual gate, audience-first. The very same
  // question backs the `canEdit` hint on the GET above.
  @Patch(':id')
  @RequireSectionAccess(PROFILE_IDENTITY_SECTION, 'write')
  async update(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return toUserResponse(
      await this.editUserAction.execute(id, dto, session.userId),
    );
  }

  // Self-only by identity (FR-9 / Open Decision vi) — NOT a functional
  // permission, so no `@RequireFeature*` and no facade call; `SelfOnlyGuard`
  // enforces `session.userId === :id`. Mirrors `umac-09`.
  @Put(':id/photo')
  @SelfOnly()
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: { fileSize: PHOTO_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        if (PHOTO_ALLOWED_MIME.includes(file.mimetype)) {
          cb(null, true);
          return;
        }
        cb(
          new BadRequestException(
            `unsupported photo content type "${file.mimetype}" (allowed: ${PHOTO_ALLOWED_MIME.join(', ')})`,
          ),
          false,
        );
      },
    }),
  )
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file || file.size === 0 || !file.buffer?.length) {
      throw new BadRequestException('a non-empty photo file is required');
    }

    return toUserResponse(
      await this.uploadUserPhotoAction.execute(id, file.buffer, file.mimetype),
    );
  }

  @Delete(':id')
  @RequireFeature(DEACTIVATE_USER_FEATURE)
  async deactivate(@Param('id') id: string) {
    return toUserResponse(await this.deactivateUserAction.execute(id));
  }
}
