import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AccessControlModule } from '../access-control/access-control.module';
import { ActionItemsController } from './application/controllers/action-items.controller';
import { AuthController } from './application/controllers/auth.controller';
import { DepartmentsController } from './application/controllers/departments.controller';
import { MeController } from './application/controllers/me.controller';
import { MentorshipPairsController } from './application/controllers/mentorship-pairs.controller';
import { UsersController } from './application/controllers/users.controller';
import { DEPARTURE_REPOSITORY_PORT } from './domain/interfaces/departure-repository.port';
import { RELATIONSHIP_WRITE_REPOSITORY_PORT } from './domain/interfaces/relationship-write-repository.port';
import { DepartureService } from './domain/services/departure.service';
import { RelationshipWriteService } from './domain/services/relationship-write.service';
import { DepartureExecutorService } from './infrastructure/departure-executor.service';
import { DepartureRepository } from './infrastructure/departure.repository';
import { MagicLinkRepository } from './infrastructure/magic-link.repository';
import { NodemailerMagicLinkMailer } from './infrastructure/nodemailer-magic-link-mailer.adapter';
import { ProfileDataRepository } from './infrastructure/profile-data.repository';
import { RelationshipWriteRepository } from './infrastructure/relationship-write.repository';

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
  imports: [AccessControlModule, ScheduleModule.forRoot()],
  providers: [
    ProfileDataRepository,
    MagicLinkRepository,
    NodemailerMagicLinkMailer,
    RelationshipWriteService,
    {
      provide: RELATIONSHIP_WRITE_REPOSITORY_PORT,
      useClass: RelationshipWriteRepository,
    },
    DepartureService,
    { provide: DEPARTURE_REPOSITORY_PORT, useClass: DepartureRepository },
    DepartureExecutorService,
  ],
  controllers: [
    UsersController,
    MeController,
    MentorshipPairsController,
    ActionItemsController,
    AuthController,
    DepartmentsController,
  ],
  exports: [],
})
export class UserManagementModule {}
