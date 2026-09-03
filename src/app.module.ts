import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AccessControlModule } from './access-control/access-control.module';
import { HttpLoggerMiddleware } from './common/logging/http-logger.middleware';
import { LoggingInterceptor } from './common/logging/logging.interceptor';
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
  providers: [{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // `{*path}` is the Express 5 / path-to-regexp named-wildcard form for
    // "every route" — the bare `*` still works but logs a LegacyRouteConverter
    // deprecation warning on boot.
    consumer.apply(HttpLoggerMiddleware).forRoutes('{*path}');
  }
}
