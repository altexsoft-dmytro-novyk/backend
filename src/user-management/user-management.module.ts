import { Module } from '@nestjs/common';
import { ACCESS_CONTROL_PORT } from './domain/interfaces/access-control.port';
import { IDENTITY_CARD_ACCESS_PORT } from './domain/interfaces/identity-card-access.port';
import { MAGIC_LINK_DISPATCHER_PORT } from './domain/interfaces/magic-link-dispatcher.port';
import { POPULATION_IMPORT_REPOSITORY_PORT } from './domain/interfaces/population-import.repository.port';
import { SESSION_RESOLVER_PORT } from './domain/interfaces/session-resolver.port';
import { USER_REPOSITORY_PORT } from './domain/interfaces/user.repository.port';
import { UsersController } from './application/controllers/users.controller';
import { DeactivateUserAction } from './application/actions/deactivate-user.action';
import { EditUserAction } from './application/actions/edit-user.action';
import { GetUserCardAction } from './application/actions/get-user-card.action';
import { ImportPopulationAction } from './application/actions/import-population.action';
import { ListUsersAction } from './application/actions/list-users.action';
import { UploadUserPhotoAction } from './application/actions/upload-user-photo.action';
import { AccessControlGuard } from './application/guards/access-control.guard';
import { SelfOnlyGuard } from './application/guards/self-only.guard';
import { SessionGuard } from './application/guards/session.guard';
import { IdentityCardAccessService } from './domain/services/identity-card-access.service';
import { PopulationImportService } from './domain/services/population-import.service';
import { UserService } from './domain/services/user.service';
import { AccessControlFacadeAdapter } from './infrastructure/access-control-facade.adapter';
import { InterimSessionResolverAdapter } from './infrastructure/interim-session-resolver.adapter';
import { MagicLinkDispatcherFake } from './infrastructure/magic-link-dispatcher.fake';
import { PopulationImportRepository } from './infrastructure/population-import.repository';
import { UserRepository } from './infrastructure/user.repository';

@Module({
  controllers: [UsersController],
  providers: [
    EditUserAction,
    GetUserCardAction,
    UploadUserPhotoAction,
    DeactivateUserAction,
    ListUsersAction,
    ImportPopulationAction,
    SessionGuard,
    AccessControlGuard,
    SelfOnlyGuard,
    UserService,
    IdentityCardAccessService,
    PopulationImportService,
    AccessControlFacadeAdapter,
    { provide: USER_REPOSITORY_PORT, useClass: UserRepository },
    {
      provide: POPULATION_IMPORT_REPOSITORY_PORT,
      useClass: PopulationImportRepository,
    },
    { provide: MAGIC_LINK_DISPATCHER_PORT, useClass: MagicLinkDispatcherFake },
    { provide: SESSION_RESOLVER_PORT, useClass: InterimSessionResolverAdapter },
    { provide: ACCESS_CONTROL_PORT, useExisting: AccessControlFacadeAdapter },
    {
      provide: IDENTITY_CARD_ACCESS_PORT,
      useExisting: AccessControlFacadeAdapter,
    },
  ],
})
export class UserManagementModule {}
