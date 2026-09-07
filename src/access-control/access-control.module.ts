import { Global, Module } from '@nestjs/common';
import { AccessControlFacade } from './application/access-control.facade';
import { FULL_PROFILE_ACCESS_PORT } from './domain/interfaces/full-profile-access.port';
import { IDENTITY_PORT } from './domain/interfaces/identity.port';
import { RELATIONSHIP_GRAPH_PORT } from './domain/interfaces/relationship-graph.port';
import { AudienceResolverService } from './domain/services/audience-resolver.service';
import { FullProfileOverlayService } from './domain/services/full-profile-overlay.service';
import { FunctionalRoleEvaluatorService } from './domain/services/functional-role-evaluator.service';
import { FUNCTIONAL_ROLE_REPOSITORY_PORT } from './domain/interfaces/functional-role.repository.port';
import { PrismaFullProfileAccessAdapter } from './infrastructure/prisma-full-profile-access.adapter';
import { PrismaFunctionalRoleRepository } from './infrastructure/prisma-functional-role.repository';
import { PrismaIdentityAdapter } from './infrastructure/prisma-identity.adapter';
import { PrismaRelationshipGraphAdapter } from './infrastructure/prisma-relationship-graph.adapter';

// Imported by AppModule (ACM-8/CAP-6): AccessControlFacade is resolvable from
// the real application container. That is a DI-visibility change only, not
// authorization adoption — user-management.module.ts still binds
// ACCESS_CONTROL_PORT to InterimAccessControlAdapter, and GET /users/:id
// keeps the interim adapter in production. Rebinding ACCESS_CONTROL_PORT away
// from it remains User Management's own, separately-gated story (AD-2); it is
// not a consequence of this module being importable or imported.
// Global because AD-9 makes this facade the authorization entry point in every
// context: a consumer must be able to inject it without re-declaring the wiring
// (PrismaModule is global here for the same reason).
@Global()
@Module({
  providers: [
    AccessControlFacade,
    AudienceResolverService,
    FunctionalRoleEvaluatorService,
    FullProfileOverlayService,
    {
      provide: RELATIONSHIP_GRAPH_PORT,
      useClass: PrismaRelationshipGraphAdapter,
    },
    {
      provide: IDENTITY_PORT,
      useClass: PrismaIdentityAdapter,
    },
    {
      provide: FUNCTIONAL_ROLE_REPOSITORY_PORT,
      useClass: PrismaFunctionalRoleRepository,
    },
    {
      provide: FULL_PROFILE_ACCESS_PORT,
      useClass: PrismaFullProfileAccessAdapter,
    },
  ],
  exports: [AccessControlFacade],
})
export class AccessControlModule {}
