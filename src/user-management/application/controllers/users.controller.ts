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
import { DeactivateUserAction } from '../actions/deactivate-user.action';
import { EditUserAction } from '../actions/edit-user.action';
import { GetUserCardAction } from '../actions/get-user-card.action';
import { GetUserEventsAction } from '../actions/get-user-events.action';
import { ImportPopulationAction } from '../actions/import-population.action';
import { ListUsersAction } from '../actions/list-users.action';
import { UploadUserPhotoAction } from '../actions/upload-user-photo.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import {
  RequireFeature,
  RequireFeatureForTarget,
} from '../decorators/require-feature.decorator';
import { SelfOnly } from '../decorators/self-only.decorator';
import { ListUsersQueryDto } from '../dtos/list-users-query.dto';
import { UpdateUserDto } from '../dtos/update-user.dto';
import { toUserResponse } from '../dtos/user.response';
import {
  toUserListItem,
  type UserListItem,
} from '../dtos/user-list-item.response';
import type { UserCardResponse } from '../dtos/user-card.response';
import type { UserEventsEnvelope } from '../dtos/user-event.response';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SelfOnlyGuard } from '../guards/self-only.guard';
import { SessionGuard } from '../guards/session.guard';
import type { Session } from '../../domain/interfaces/session-resolver.port';
import { PaginatedResponseDto } from '../../../common/dtos/paginated-response.dto';

// The seeded-population import reuses the existing kernel permission the retired
// `POST /users` required (AD-21 / seed README) — no new `user-management:import`
// key. In the seeded system this key is held only by the HR-Admin root.
const IMPORT_POPULATION_FEATURE = 'user-management:create';
const EDIT_USER_FEATURE = 'user-management:edit';
const READ_USER_FEATURE = 'user-management:read';
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
@UseGuards(SessionGuard, AccessControlGuard, SelfOnlyGuard)
export class UsersController {
  constructor(
    private readonly editUserAction: EditUserAction,
    private readonly getUserCardAction: GetUserCardAction,
    private readonly uploadUserPhotoAction: UploadUserPhotoAction,
    private readonly deactivateUserAction: DeactivateUserAction,
    private readonly listUsersAction: ListUsersAction,
    private readonly importPopulationAction: ImportPopulationAction,
    private readonly getUserEventsAction: GetUserEventsAction,
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

  @Get(':id')
  @RequireFeatureForTarget(READ_USER_FEATURE)
  async findOne(
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ): Promise<UserCardResponse> {
    return this.getUserCardAction.execute(session.userId, id);
  }

  // Distinct path from `:id` (`:id/events` never collides with `:id`); declared
  // beside the other `:id` routes. Read gate is INSIDE the action — the
  // career-timeline S9 read audience excludes colleague, so it is NOT
  // `@RequireFeatureForTarget` (that is the S1 audience). `SessionGuard`
  // produces the `401` for a missing/invalid token.
  @Get(':id/events')
  async findEvents(
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ): Promise<UserEventsEnvelope> {
    return this.getUserEventsAction.execute(session.userId, id);
  }

  @Patch(':id')
  @RequireFeatureForTarget(EDIT_USER_FEATURE)
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
