import { Module } from '@nestjs/common';

// AD-3 module-boundary corollary: the narrow, guard-free module that will
// export user-management's org-graph read service(s) for access-control's
// OrgGraphReaderPort adapter to consume. This module must never import
// AccessControlModule, directly or transitively — AccessControlModule
// imports only this module, never the controller-bearing
// UserManagementModule, so the two capability-level edges (authorize vs.
// supply-facts) terminate in different modules and neither imports the
// other back.
//
// Empty scaffold for now — the org-graph query service and its exports land
// with the story that implements OrgGraphReaderPort.
@Module({
  imports: [],
  providers: [],
  exports: [],
})
export class UserManagementQueryModule {}
