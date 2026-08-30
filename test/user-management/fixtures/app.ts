import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Shared app bootstrap for the user-management E2E suites (seed/, auth/).
// Mirrors test/access-control/fixtures/graph.ts's bootstrapApp — same
// mirroring of main.ts's global pipe (main.ts's bootstrap config is not
// inherited by the Nest testing module, per .claude/rules/nest-e2e.md).
export async function bootstrapApp(): Promise<{
  app: INestApplication<App>;
  prisma: PrismaService;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma };
}
