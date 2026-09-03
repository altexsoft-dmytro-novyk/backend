import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AccessControlModule } from './access-control/access-control.module';
import { envValidationSchema } from './config/env.validation';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { UserManagementModule } from './user-management/user-management.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    // Epic 5 Story 5.2 (AD-20) — the composition-root scheduler registry the
    // effective-departure worker registers its DB-polling interval on. `forRoot`
    // belongs at the root module, not in `UserManagementModule`.
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    HealthModule,
    AccessControlModule,
    UserManagementModule,
  ],
})
export class AppModule {}
