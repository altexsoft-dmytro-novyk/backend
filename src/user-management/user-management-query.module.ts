import { Module } from '@nestjs/common';
import { OrgGraphQueryAction } from './application/actions/org-graph-query.action';
import { ORG_GRAPH_REPOSITORY_PORT } from './domain/interfaces/org-graph-repository.port';
import { OrgGraphQueryService } from './domain/services/org-graph-query.service';
import { OrgGraphRepository } from './infrastructure/org-graph.repository';

// AD-3 module-boundary corollary: the narrow, guard-free module that will
// export user-management's org-graph read service(s) for access-control's
// OrgGraphReaderPort adapter to consume. This module must never import
// AccessControlModule, directly or transitively — AccessControlModule
// imports only this module, never the controller-bearing
// UserManagementModule, so the two capability-level edges (authorize vs.
// supply-facts) terminate in different modules and neither imports the
// other back.
@Module({
  imports: [],
  providers: [
    { provide: ORG_GRAPH_REPOSITORY_PORT, useClass: OrgGraphRepository },
    OrgGraphQueryService,
    OrgGraphQueryAction,
  ],
  exports: [OrgGraphQueryAction],
})
export class UserManagementQueryModule {}
