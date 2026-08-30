import { Module } from '@nestjs/common';
import { UserManagementQueryModule } from '../user-management/user-management-query.module';

// AD-3: access-control -> user-management for org-graph facts, via
// OrgGraphReaderPort implemented by an infrastructure adapter that calls
// user-management's exported application-layer query service, in-process,
// live, never cached.
//
// Module-boundary corollary: imports ONLY the narrow UserManagementQueryModule
// — never UserManagementModule, which is the controller-bearing module that
// imports AccessControlModule for its guards. This keeps the two dependency
// edges (authorize vs. supply-facts) from becoming a NestJS circular import.
//
// Empty scaffold for now — the AccessControl facade (isAllowed /
// canAccessSection), Policy/Permission/UserPolicy/FullProfileAccessGrant
// domain, and the /roles admin API land with their respective stories.
@Module({
  imports: [UserManagementQueryModule],
  providers: [],
  exports: [],
})
export class AccessControlModule {}
