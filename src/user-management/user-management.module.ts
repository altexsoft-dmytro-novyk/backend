import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ACCESS_CONTROL_PORT } from './domain/interfaces/access-control.port';
import { AUTH_USER_LOOKUP_PORT } from './domain/interfaces/auth-user-lookup.port';
import { IDENTITY_CARD_ACCESS_PORT } from './domain/interfaces/identity-card-access.port';
import { MAGIC_LINK_DISPATCHER_PORT } from './domain/interfaces/magic-link-dispatcher.port';
import { MAGIC_LINK_TOKEN_REPOSITORY_PORT } from './domain/interfaces/magic-link-token.repository.port';
import { MAGIC_LINK_TTL_MINUTES } from './domain/interfaces/magic-link-ttl.token';
import { POPULATION_IMPORT_REPOSITORY_PORT } from './domain/interfaces/population-import.repository.port';
import { SESSION_RESOLVER_PORT } from './domain/interfaces/session-resolver.port';
import { SESSION_TOKEN_ISSUER_PORT } from './domain/interfaces/session-token-issuer.port';
import { USER_REPOSITORY_PORT } from './domain/interfaces/user.repository.port';
import { AuthController } from './application/controllers/auth.controller';
import { UsersController } from './application/controllers/users.controller';
import { DeactivateUserAction } from './application/actions/deactivate-user.action';
import { EditUserAction } from './application/actions/edit-user.action';
import { GetUserCardAction } from './application/actions/get-user-card.action';
import { ImportPopulationAction } from './application/actions/import-population.action';
import { ListUsersAction } from './application/actions/list-users.action';
import { ConsumeMagicLinkAction } from './application/actions/consume-magic-link.action';
import { RequestMagicLinkAction } from './application/actions/request-magic-link.action';
import { UploadUserPhotoAction } from './application/actions/upload-user-photo.action';
import { AccessControlGuard } from './application/guards/access-control.guard';
import { SelfOnlyGuard } from './application/guards/self-only.guard';
import { SessionGuard } from './application/guards/session.guard';
import { IdentityCardAccessService } from './domain/services/identity-card-access.service';
import { MagicLinkService } from './domain/services/magic-link.service';
import { PopulationImportService } from './domain/services/population-import.service';
import { UserService } from './domain/services/user.service';
import { AccessControlFacadeAdapter } from './infrastructure/access-control-facade.adapter';
import { AuthUserLookupRepository } from './infrastructure/auth-user-lookup.repository';
import { JwtSessionResolverAdapter } from './infrastructure/jwt-session-resolver.adapter';
import { JwtSessionTokenIssuerAdapter } from './infrastructure/jwt-session-token-issuer.adapter';
import { MagicLinkTokenRepository } from './infrastructure/magic-link-token.repository';
import { PopulationImportRepository } from './infrastructure/population-import.repository';
import { SmtpMagicLinkDispatcherAdapter } from './infrastructure/smtp-magic-link-dispatcher.adapter';
import { UserRepository } from './infrastructure/user.repository';

@Module({
  controllers: [UsersController, AuthController],
  providers: [
    EditUserAction,
    GetUserCardAction,
    UploadUserPhotoAction,
    DeactivateUserAction,
    ListUsersAction,
    ImportPopulationAction,
    RequestMagicLinkAction,
    ConsumeMagicLinkAction,
    SessionGuard,
    AccessControlGuard,
    SelfOnlyGuard,
    UserService,
    IdentityCardAccessService,
    PopulationImportService,
    MagicLinkService,
    AccessControlFacadeAdapter,
    { provide: USER_REPOSITORY_PORT, useClass: UserRepository },
    {
      provide: POPULATION_IMPORT_REPOSITORY_PORT,
      useClass: PopulationImportRepository,
    },
    {
      provide: MAGIC_LINK_DISPATCHER_PORT,
      useClass: SmtpMagicLinkDispatcherAdapter,
    },
    {
      provide: MAGIC_LINK_TOKEN_REPOSITORY_PORT,
      useClass: MagicLinkTokenRepository,
    },
    { provide: AUTH_USER_LOOKUP_PORT, useClass: AuthUserLookupRepository },
    {
      provide: MAGIC_LINK_TTL_MINUTES,
      useFactory: (config: ConfigService) =>
        config.getOrThrow<number>('MAGIC_LINK_TTL_MINUTES'),
      inject: [ConfigService],
    },
    // AD-21 cutover (auth/README decision 12): the real session resolver +
    // issuer land here and `interim-session-resolver.adapter.ts` is deleted.
    // One adapter — the interim `Bearer <token:<persona>>` shorthand is folded
    // into `JwtSessionResolverAdapter` behind `ALLOW_TEST_SESSION_TOKENS`.
    {
      provide: SESSION_TOKEN_ISSUER_PORT,
      useClass: JwtSessionTokenIssuerAdapter,
    },
    { provide: SESSION_RESOLVER_PORT, useClass: JwtSessionResolverAdapter },
    { provide: ACCESS_CONTROL_PORT, useExisting: AccessControlFacadeAdapter },
    {
      provide: IDENTITY_CARD_ACCESS_PORT,
      useExisting: AccessControlFacadeAdapter,
    },
  ],
})
export class UserManagementModule {}
