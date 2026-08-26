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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DeactivateUserAction } from '../actions/deactivate-user.action';
import { EditUserAction } from '../actions/edit-user.action';
import { GetUserAction } from '../actions/get-user.action';
import { ListUsersAction } from '../actions/list-users.action';
import { RegisterUserAction } from '../actions/register-user.action';
import { UploadUserPhotoAction } from '../actions/upload-user-photo.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import {
  RequireFeature,
  RequireFeatureForTarget,
} from '../decorators/require-feature.decorator';
import { CreateUserDto } from '../dtos/create-user.dto';
import { ListUsersQueryDto } from '../dtos/list-users-query.dto';
import { UpdateUserDto } from '../dtos/update-user.dto';
import { toUserResponse, type UserResponse } from '../dtos/user.response';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SessionGuard } from '../guards/session.guard';
import type { Session } from '../../domain/interfaces/session-resolver.port';
import { PaginatedResponseDto } from '../../../common/dtos/paginated-response.dto';

const CREATE_USER_FEATURE = 'user-management:create';
const EDIT_USER_FEATURE = 'user-management:edit';
const READ_USER_FEATURE = 'user-management:read';
const UPLOAD_PHOTO_FEATURE = 'user-management:upload-photo';
const DEACTIVATE_USER_FEATURE = 'user-management:deactivate';
const LIST_USERS_FEATURE = 'user-management:list';

@Controller('users')
@UseGuards(SessionGuard, AccessControlGuard)
export class UsersController {
  constructor(
    private readonly registerUserAction: RegisterUserAction,
    private readonly editUserAction: EditUserAction,
    private readonly getUserAction: GetUserAction,
    private readonly uploadUserPhotoAction: UploadUserPhotoAction,
    private readonly deactivateUserAction: DeactivateUserAction,
    private readonly listUsersAction: ListUsersAction,
  ) {}

  @Get()
  @RequireFeature(LIST_USERS_FEATURE)
  async findAll(
    @Query() query: ListUsersQueryDto,
  ): Promise<PaginatedResponseDto<UserResponse>> {
    const page = await this.listUsersAction.execute(query);
    return new PaginatedResponseDto(
      page.items.map(toUserResponse),
      page.total,
      page.page,
      page.pageSize,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireFeature(CREATE_USER_FEATURE)
  async create(@CurrentSession() session: Session, @Body() dto: CreateUserDto) {
    return toUserResponse(
      await this.registerUserAction.execute(dto, session.userId),
    );
  }

  @Get(':id')
  @RequireFeatureForTarget(READ_USER_FEATURE)
  async findOne(@Param('id') id: string) {
    return toUserResponse(await this.getUserAction.execute(id));
  }

  @Patch(':id')
  @RequireFeatureForTarget(EDIT_USER_FEATURE)
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return toUserResponse(await this.editUserAction.execute(id, dto));
  }

  @Put(':id/photo')
  @RequireFeatureForTarget(UPLOAD_PHOTO_FEATURE)
  @UseInterceptors(FileInterceptor('photo'))
  async uploadPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('photo file is required');
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
