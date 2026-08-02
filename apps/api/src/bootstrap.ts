import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request } from 'express';
import type express from 'express';
import helmet from 'helmet';
import { ErrorTrackingService } from './common/error-tracking/error-tracking.service.js';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { HttpMetricsInterceptor } from './common/interceptors/http-metrics.interceptor.js';
import { MetricsService } from './common/metrics/metrics.service.js';

/** Request augmented with the raw JSON body (needed for webhook HMAC verification). */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/** Builds the OpenAPI document (Wave P: single source for UI, JSON spec, generator). */
export function buildOpenApiDocument(app: NestExpressApplication) {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('AgricPlatform API')
    .setDescription('Modular NestJS API for the NYFN farmer platform (PRD v3.3 Phase 1).')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'oidc')
    .addApiKey({ type: 'apiKey', name: 'x-user-id', in: 'header' }, 'x-user-id')
    .build();
  return SwaggerModule.createDocument(app, swaggerConfig);
}

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

  // JSON body limit for low-bandwidth PWA payloads. The raw body is preserved
  // so provider webhooks can verify HMAC signatures over the exact payload.
  app.useBodyParser('json', {
    limit: process.env.JSON_BODY_LIMIT ?? '1mb',
    verify: (req: RawBodyRequest, _res: unknown, buf: Buffer) => {
      req.rawBody = buf;
    }
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidUnknownValues: false
    })
  );
  app.useGlobalFilters(
    new ApiExceptionFilter(app.get(MetricsService), app.get(ErrorTrackingService))
  );
  // IdempotencyInterceptor is registered via APP_INTERCEPTOR (DI-managed store).
  // Request metrics replaced request logging in this slot (plan §A.3); pino-http
  // handles structured request logging itself.
  app.useGlobalInterceptors(app.get(HttpMetricsInterceptor));

  // API documentation is disabled in production unless explicitly enabled.
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true') {
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup('api/v1/docs', app, document);
  }

  // Wave P: the generated OpenAPI spec is always served as JSON (the web
  // developer portal regenerates its catalogue from this document).
  const openApiHandler: express.RequestHandler = (_req, res) => {
    res.json(buildOpenApiDocument(app));
  };
  app.getHttpAdapter().getInstance().get('/api/v1/openapi.json', openApiHandler);

  app.enableShutdownHooks();
}
