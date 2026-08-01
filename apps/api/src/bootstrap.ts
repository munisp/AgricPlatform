import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor.js';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor.js';

/** Shared HTTP configuration used by main.ts and e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api/v1');

  // Security headers (helmet) and CORS for the Next.js PWA.
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim()),
    credentials: true
  });

  // JSON body limit for low-bandwidth PWA payloads.
  app.useBodyParser('json', { limit: process.env.JSON_BODY_LIMIT ?? '1mb' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidUnknownValues: false
    })
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor(), new IdempotencyInterceptor());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AgricPlatform API')
    .setDescription('Modular NestJS API for the NYFN farmer platform (PRD v3.3 Phase 1).')
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'x-user-id', in: 'header' }, 'x-user-id')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document);

  app.enableShutdownHooks();
}
