import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';

// AD-3: user-management -> access-control for authorization — every
// controller/action in this module calls AccessControl.isAllowed /
// canAccessSection before reading or writing.
//
// This is the controller-bearing module (S1 CRUD, relationships, departure,
// magic-link auth, events). It imports the full AccessControlModule for its
// guards. AccessControlModule itself imports only UserManagementQueryModule
// (see that module and access-control.module.ts), never this module back —
// so this import does not create a NestJS circular import.
//
// Empty scaffold for now — controllers/actions/domain services land with
// their respective stories.
@Module({
  imports: [AccessControlModule],
  providers: [],
  controllers: [],
  exports: [],
})
export class UserManagementModule {}
