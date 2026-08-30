import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { ActionItemsController } from './application/controllers/action-items.controller';
import { AuthController } from './application/controllers/auth.controller';
import { MentorshipPairsController } from './application/controllers/mentorship-pairs.controller';
import { UsersController } from './application/controllers/users.controller';
import { MagicLinkRepository } from './infrastructure/magic-link.repository';
import { ProfileDataRepository } from './infrastructure/profile-data.repository';

// AD-3: user-management -> access-control for authorization — every
// controller/action in this module calls AccessControl.isAllowed /
// canAccessSection before reading or writing.
//
// This is the controller-bearing module (S1 CRUD, relationships, departure,
// magic-link auth, events). It imports the full AccessControlModule for its
// guards. AccessControlModule itself imports only UserManagementQueryModule
// (see that module and access-control.module.ts), never this module back —
// so this import does not create a NestJS circular import.
@Module({
  imports: [AccessControlModule],
  providers: [ProfileDataRepository, MagicLinkRepository],
  controllers: [
    UsersController,
    MentorshipPairsController,
    ActionItemsController,
    AuthController,
  ],
  exports: [],
})
export class UserManagementModule {}
