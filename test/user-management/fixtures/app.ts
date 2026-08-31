import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Shared app bootstrap for the user-management E2E suites (seed/, auth/).
// Mirrors test/access-control/fixtures/graph.ts's bootstrapApp — same
// mirroring of main.ts's global pipe (main.ts's bootstrap config is not
// inherited by the Nest testing module, per .claude/rules/nest-e2e.md).
//
// `customize` lets a suite override a provider before compile (e.g. swap the
// magic-link mailer for a recording fake to assert delivery).
export async function bootstrapApp(
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<{
  app: INestApplication<App>;
  moduleRef: TestingModule;
  prisma: PrismaService;
}> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef: TestingModule = await builder.compile();

  const app: INestApplication<App> = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, moduleRef, prisma };
}
