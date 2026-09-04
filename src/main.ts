import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { parseCorsOrigins } from './config/cors-origins';
import { parseLogLevels } from './common/logging/log-levels';

async function bootstrap() {
  // Buffer startup logs until `useLogger` applies the env-configured levels, so
  // nothing before that point escapes the `LOG_LEVELS` filter.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.useLogger(parseLogLevels(config.get<string>('LOG_LEVELS')));

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  app.enableCors({
    // `CORS_ORIGIN` is a comma-separated list — the `cors` package matches the
    // request Origin against each entry and reflects the match back.
    origin: parseCorsOrigins(config.getOrThrow<string>('CORS_ORIGIN')),
  });

  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('API')
    .setDescription('Backend API documentation')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.getOrThrow<number>('PORT');
  await app.listen(port);
  Logger.log(
    `API listening on port ${port} (env=${config.get<string>('NODE_ENV')})`,
    'Bootstrap',
  );
}

void bootstrap();
