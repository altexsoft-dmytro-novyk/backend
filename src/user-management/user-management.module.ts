import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ACCESS_CONTROL_PORT } from './domain/interfaces/access-control.port';
import { AUTH_USER_LOOKUP_PORT } from './domain/interfaces/auth-user-lookup.port';
import { CAREER_TIMELINE_ACCESS_PORT } from './domain/interfaces/career-timeline-access.port';
import { ACCESS_JOURNAL_ACCESS_PORT } from './domain/interfaces/access-journal-access.port';
import { ACCESS_JOURNAL_REPOSITORY_PORT } from './domain/interfaces/access-journal.repository.port';
import { ORG_RELATIONSHIP_WRITER_PORT } from './domain/interfaces/org-relationship-writer.port';
import { ORG_RELATIONSHIP_READER_PORT } from './domain/interfaces/org-relationship-reader.port';
import { ORG_RELATIONSHIPS_READ_ACCESS_PORT } from './domain/interfaces/org-relationships-read-access.port';
import { DEPARTURE_REPOSITORY_PORT } from './domain/interfaces/departure.repository.port';
import { DEPARTURE_EXECUTOR_PORT } from './domain/interfaces/departure-executor.port';
import { DEPARTURE_EFFECTS_PORT } from './domain/interfaces/departure-effects.port';
import { BUSINESS_TIME_ZONE } from './domain/interfaces/business-time-zone.token';
import { IDENTITY_CARD_ACCESS_PORT } from './domain/interfaces/identity-card-access.port';
import { USER_EVENT_REPOSITORY_PORT } from './domain/interfaces/user-event.repository.port';
import { MAGIC_LINK_DISPATCHER_PORT } from './domain/interfaces/magic-link-dispatcher.port';
import { MAGIC_LINK_TOKEN_REPOSITORY_PORT } from './domain/interfaces/magic-link-token.repository.port';
import { MAGIC_LINK_TTL_MINUTES } from './domain/interfaces/magic-link-ttl.token';
import { POPULATION_IMPORT_REPOSITORY_PORT } from './domain/interfaces/population-import.repository.port';
import { SESSION_RESOLVER_PORT } from './domain/interfaces/session-resolver.port';
import { SESSION_TOKEN_ISSUER_PORT } from './domain/interfaces/session-token-issuer.port';
import { USER_REPOSITORY_PORT } from './domain/interfaces/user.repository.port';
import { AuthController } from './application/controllers/auth.controller';
import { UsersController } from './application/controllers/users.controller';
import { RelationshipsController } from './application/controllers/relationships.controller';
import { DepartmentsController } from './application/controllers/departments.controller';
import { DeparturesController } from './application/controllers/departures.controller';
import { DepartureHealthController } from './application/controllers/departure-health.controller';
import { AddManualUserEventAction } from './application/actions/add-manual-user-event.action';
import { DeactivateUserAction } from './application/actions/deactivate-user.action';
import { EditUserAction } from './application/actions/edit-user.action';
import { GetUserCardAction } from './application/actions/get-user-card.action';
import { GetUserEventsAction } from './application/actions/get-user-events.action';
import { AssignManagerAction } from './application/actions/assign-manager.action';
import { RevokeManagerAction } from './application/actions/revoke-manager.action';
import { ChangePeoplePartnerAction } from './application/actions/change-people-partner.action';
import { RemovePeoplePartnerAction } from './application/actions/remove-people-partner.action';
import { GetAccessJournalAction } from './application/actions/get-access-journal.action';
import { GetRelationshipsAction } from './application/actions/get-relationships.action';
import { AddDepartmentMembershipAction } from './application/actions/add-department-membership.action';
import { RemoveDepartmentMembershipAction } from './application/actions/remove-department-membership.action';
import { SetDepartmentManagerAction } from './application/actions/set-department-manager.action';
import { RemoveDepartmentManagerAction } from './application/actions/remove-department-manager.action';
import { RecordDepartureAction } from './application/actions/record-departure.action';
import { GetDepartureAction } from './application/actions/get-departure.action';
import { ReparentDepartureAction } from './application/actions/reparent-departure.action';
import { RetryDepartureAction } from './application/actions/retry-departure.action';
import { ImportPopulationAction } from './application/actions/import-population.action';
import { ListUsersAction } from './application/actions/list-users.action';
import { SoftDeleteUserEventAction } from './application/actions/soft-delete-user-event.action';
import { ConsumeMagicLinkAction } from './application/actions/consume-magic-link.action';
import { RequestMagicLinkAction } from './application/actions/request-magic-link.action';
import { UploadUserPhotoAction } from './application/actions/upload-user-photo.action';
import { AccessControlGuard } from './application/guards/access-control.guard';
import { SelfOnlyGuard } from './application/guards/self-only.guard';
import { SessionGuard } from './application/guards/session.guard';
import { CareerTimelineAccessService } from './domain/services/career-timeline-access.service';
import { CareerTimelineService } from './domain/services/career-timeline.service';
import { OrgRelationshipService } from './domain/services/org-relationship.service';
import { DepartureService } from './domain/services/departure.service';
import { AccessJournalService } from './domain/services/access-journal.service';
import { AccessJournalAccessService } from './domain/services/access-journal-access.service';
import { OrgRelationshipReadService } from './domain/services/org-relationship-read.service';
import { OrgRelationshipsReadAccessService } from './domain/services/org-relationships-read-access.service';
import { IdentityCardAccessService } from './domain/services/identity-card-access.service';
import { MagicLinkService } from './domain/services/magic-link.service';
import { PopulationImportService } from './domain/services/population-import.service';
import { UserService } from './domain/services/user.service';
import { AccessControlFacadeAdapter } from './infrastructure/access-control-facade.adapter';
import { AuthUserLookupRepository } from './infrastructure/auth-user-lookup.repository';
import { CareerTimelineAccessFacadeAdapter } from './infrastructure/career-timeline-access-facade.adapter';
import { OrgRelationshipRepository } from './infrastructure/org-relationship.repository';
import { DepartureRepository } from './infrastructure/departure.repository';
import { DepartureWorkerService } from './infrastructure/departure-worker.service';
import { DepartureMetricsService } from './infrastructure/departure-metrics.service';
import { NoopDepartureEffectsParticipant } from './infrastructure/noop-departure-effects.participant';
import { AccessJournalRepository } from './infrastructure/access-journal.repository';
import { AccessJournalAccessFacadeAdapter } from './infrastructure/access-journal-access-facade.adapter';
import { OrgRelationshipReaderRepository } from './infrastructure/org-relationship-reader.repository';
import { OrgRelationshipsReadAccessFacadeAdapter } from './infrastructure/org-relationships-read-access-facade.adapter';
import { UserEventRepository } from './infrastructure/user-event.repository';
import { JwtSessionResolverAdapter } from './infrastructure/jwt-session-resolver.adapter';
import { JwtSessionTokenIssuerAdapter } from './infrastructure/jwt-session-token-issuer.adapter';
import { MagicLinkTokenRepository } from './infrastructure/magic-link-token.repository';
import { PopulationImportRepository } from './infrastructure/population-import.repository';
import { SmtpMagicLinkDispatcherAdapter } from './infrastructure/smtp-magic-link-dispatcher.adapter';
import { UserRepository } from './infrastructure/user.repository';

@Module({
  controllers: [
    UsersController,
    RelationshipsController,
    DepartmentsController,
    DeparturesController,
    DepartureHealthController,
    AuthController,
  ],
  providers: [
    EditUserAction,
    GetUserCardAction,
    UploadUserPhotoAction,
    DeactivateUserAction,
    ListUsersAction,
    ImportPopulationAction,
    GetUserEventsAction,
    AddManualUserEventAction,
    SoftDeleteUserEventAction,
    AssignManagerAction,
    RevokeManagerAction,
    ChangePeoplePartnerAction,
    RemovePeoplePartnerAction,
    GetAccessJournalAction,
    GetRelationshipsAction,
    AddDepartmentMembershipAction,
    RemoveDepartmentMembershipAction,
    SetDepartmentManagerAction,
    RemoveDepartmentManagerAction,
    RecordDepartureAction,
    GetDepartureAction,
    ReparentDepartureAction,
    RetryDepartureAction,
    RequestMagicLinkAction,
    ConsumeMagicLinkAction,
    SessionGuard,
    AccessControlGuard,
    SelfOnlyGuard,
    UserService,
    IdentityCardAccessService,
    CareerTimelineService,
    CareerTimelineAccessService,
    OrgRelationshipService,
    DepartureService,
    AccessJournalService,
    AccessJournalAccessService,
    OrgRelationshipReadService,
    OrgRelationshipsReadAccessService,
    PopulationImportService,
    MagicLinkService,
    AccessControlFacadeAdapter,
    { provide: USER_REPOSITORY_PORT, useClass: UserRepository },
    { provide: USER_EVENT_REPOSITORY_PORT, useClass: UserEventRepository },
    {
      provide: CAREER_TIMELINE_ACCESS_PORT,
      useClass: CareerTimelineAccessFacadeAdapter,
    },
    {
      provide: ORG_RELATIONSHIP_WRITER_PORT,
      useClass: OrgRelationshipRepository,
    },
    {
      provide: DEPARTURE_REPOSITORY_PORT,
      useClass: DepartureRepository,
    },
    // Epic 5 Story 5.2 — the effective-departure worker + its seams.
    DepartureMetricsService,
    DepartureWorkerService,
    { provide: DEPARTURE_EXECUTOR_PORT, useExisting: DepartureWorkerService },
    {
      provide: DEPARTURE_EFFECTS_PORT,
      useClass: NoopDepartureEffectsParticipant,
    },
    {
      provide: BUSINESS_TIME_ZONE,
      useFactory: (config: ConfigService) =>
        config.getOrThrow<string>('BUSINESS_TIME_ZONE'),
      inject: [ConfigService],
    },
    {
      provide: ACCESS_JOURNAL_REPOSITORY_PORT,
      useClass: AccessJournalRepository,
    },
    {
      provide: ACCESS_JOURNAL_ACCESS_PORT,
      useClass: AccessJournalAccessFacadeAdapter,
    },
    {
      provide: ORG_RELATIONSHIP_READER_PORT,
      useClass: OrgRelationshipReaderRepository,
    },
    {
      provide: ORG_RELATIONSHIPS_READ_ACCESS_PORT,
      useClass: OrgRelationshipsReadAccessFacadeAdapter,
    },
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
