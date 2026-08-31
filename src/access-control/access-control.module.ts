import { Global, Module } from '@nestjs/common';
import { AccessControlFacade } from './application/access-control.facade';
import { IDENTITY_PORT } from './domain/interfaces/identity.port';
import { RELATIONSHIP_GRAPH_PORT } from './domain/interfaces/relationship-graph.port';
import { AudienceResolverService } from './domain/services/audience-resolver.service';
import { FunctionalRoleEvaluatorService } from './domain/services/functional-role-evaluator.service';
import { FUNCTIONAL_ROLE_REPOSITORY_PORT } from './domain/interfaces/functional-role.repository.port';
import { PrismaFunctionalRoleRepository } from './infrastructure/prisma-functional-role.repository';
import { PrismaIdentityAdapter } from './infrastructure/prisma-identity.adapter';
import { PrismaRelationshipGraphAdapter } from './infrastructure/prisma-relationship-graph.adapter';

// Not imported by AppModule yet, and deliberately so: adopting the facade means
// rebinding ACCESS_CONTROL_PORT in user-management.module.ts, which is User
// Management's own story (AD-2). Until then this module is consumed by its
// tests only, and GET /users/:id keeps the interim adapter in production.
// Global because AD-9 makes this facade the authorization entry point in every
// context: a consumer must be able to inject it without re-declaring the wiring
// (PrismaModule is global here for the same reason). It becomes visible only
// once something imports it — AppModule still does not.
@Global()
@Module({
  providers: [
    AccessControlFacade,
    AudienceResolverService,
    FunctionalRoleEvaluatorService,
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
  ],
  exports: [AccessControlFacade],
})
export class AccessControlModule {}
