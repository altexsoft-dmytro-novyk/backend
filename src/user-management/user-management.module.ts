import { Module } from '@nestjs/common';
import { ACCESS_CONTROL_PORT } from './domain/interfaces/access-control.port';
import { MAGIC_LINK_DISPATCHER_PORT } from './domain/interfaces/magic-link-dispatcher.port';
import { SESSION_RESOLVER_PORT } from './domain/interfaces/session-resolver.port';
import { USER_REPOSITORY_PORT } from './domain/interfaces/user.repository.port';
import { UsersController } from './application/controllers/users.controller';
import { DeactivateUserAction } from './application/actions/deactivate-user.action';
import { EditUserAction } from './application/actions/edit-user.action';
import { GetUserAction } from './application/actions/get-user.action';
import { ListUsersAction } from './application/actions/list-users.action';
import { RegisterUserAction } from './application/actions/register-user.action';
import { UploadUserPhotoAction } from './application/actions/upload-user-photo.action';
import { AccessControlGuard } from './application/guards/access-control.guard';
import { SessionGuard } from './application/guards/session.guard';
import { UserService } from './domain/services/user.service';
import { InterimAccessControlAdapter } from './infrastructure/interim-access-control.adapter';
import { InterimSessionResolverAdapter } from './infrastructure/interim-session-resolver.adapter';
import { MagicLinkDispatcherFake } from './infrastructure/magic-link-dispatcher.fake';
import { UserRepository } from './infrastructure/user.repository';

@Module({
  controllers: [UsersController],
  providers: [
    RegisterUserAction,
    EditUserAction,
    GetUserAction,
    UploadUserPhotoAction,
    DeactivateUserAction,
    ListUsersAction,
    SessionGuard,
    AccessControlGuard,
    UserService,
    { provide: USER_REPOSITORY_PORT, useClass: UserRepository },
    { provide: MAGIC_LINK_DISPATCHER_PORT, useClass: MagicLinkDispatcherFake },
    { provide: SESSION_RESOLVER_PORT, useClass: InterimSessionResolverAdapter },
    { provide: ACCESS_CONTROL_PORT, useClass: InterimAccessControlAdapter },
  ],
})
export class UserManagementModule {}
