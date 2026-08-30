import { Module } from '@nestjs/common';
import { UserManagementQueryModule } from '../user-management/user-management-query.module';
import { AccessControlAction } from './application/actions/access-control.action';
import { RolesController } from './application/controllers/roles.controller';
import { SessionAuthGuard } from './application/guards/session-auth.guard';
import { AudienceResolverService } from './domain/services/audience-resolver.service';
import { AccessControlService } from './domain/services/access-control.service';
import { ORG_GRAPH_READER_PORT } from './domain/interfaces/org-graph-reader.port';
import { POLICY_READER_PORT } from './domain/interfaces/policy-reader.port';
import { OrgGraphReaderAdapter } from './infrastructure/org-graph-reader.adapter';
import { PolicyRepository } from './infrastructure/policy.repository';

// AD-3: access-control -> user-management for org-graph facts, via
// OrgGraphReaderPort implemented by an infrastructure adapter that calls
// user-management's exported application-layer query service, in-process,
// live, never cached.
//
// Module-boundary corollary: imports ONLY the narrow UserManagementQueryModule
// — never UserManagementModule, which is the controller-bearing module that
// imports AccessControlModule for its guards. This keeps the two dependency
// edges (authorize vs. supply-facts) from becoming a NestJS circular import.
@Module({
  imports: [UserManagementQueryModule],
  controllers: [RolesController],
  providers: [
    { provide: ORG_GRAPH_READER_PORT, useClass: OrgGraphReaderAdapter },
    { provide: POLICY_READER_PORT, useClass: PolicyRepository },
    AudienceResolverService,
    AccessControlService,
    AccessControlAction,
    SessionAuthGuard,
  ],
  exports: [AccessControlAction, SessionAuthGuard],
})
export class AccessControlModule {}
