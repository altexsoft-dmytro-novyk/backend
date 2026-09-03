import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

// `query` events go to `verbose` (a full statement log is noisy — opt in via
// `LOG_LEVELS`). Prisma `error` events land at `warn`, not `error`: this
// codebase uses unique constraints as control flow (e.g. the one-direct-manager
// race → `409`), so a Prisma error is frequently an expected, handled outcome.
// A genuinely unhandled fault still reaches the `error` log with its stack via
// `LoggingInterceptor`.
type PrismaEventClient = {
  $on(event: 'query', listener: (event: Prisma.QueryEvent) => void): void;
  $on(
    event: 'warn' | 'error',
    listener: (event: Prisma.LogEvent) => void,
  ): void;
};

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
      log: [
        { level: 'query', emit: 'event' },
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    const events = this as unknown as PrismaEventClient;
    events.$on('query', (event) => {
      this.logger.verbose(`${event.query} — ${event.duration}ms`);
    });
    events.$on('warn', (event) => {
      this.logger.warn(event.message);
    });
    events.$on('error', (event) => {
      this.logger.warn(event.message);
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('database connection pool established');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('database connection pool closed');
  }
}
