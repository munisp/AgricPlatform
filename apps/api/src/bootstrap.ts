import { ValidationPipe } from '@nestjs/common';
import { isProduction } from './common/auth/auth.config.js';
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

/**
 * L-02: resolves the Express `trust proxy` setting from TRUST_PROXY.
 * OFF (undefined) by default: per-IP throttles key on the client IP, and
 * behind a single ingress every request would share one IP (one attacker's
 * budget = the platform's budget) unless the proxy is trusted. Set
 * TRUST_PROXY to an Express trust-proxy value only when the deployment
 * terminates TLS at a known ingress that sets X-Forwarded-For (e.g. '1'
 * for one hop, or a subnet). Enabling it WITHOUT a controlled ingress lets
 * clients spoof their IP via X-Forwarded-For — worse than leaving it off.
 */
export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): number | string | undefined {
  const value = env.TRUST_PROXY;
  if (value === undefined || value === '' || value === 'false' || value === '0') {
    return undefined;
  }
  const hops = Number(value);
  return Number.isFinite(hops) ? hops : value;
}

/** Shared HTTP configuration used by main.ts and e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  const trustProxy = resolveTrustProxy();
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

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
      // V-74: reject unknown DTO fields instead of silently stripping them
      // (mass-assignment is visible to the caller, and smuggled fields can
      // never ride along undetected). Safe for the remaining interface-typed
      // bodies: their runtime metatype is Object, which the pipe skips by
      // design — verified against the full e2e suite (api/ussd/webhook/
      // partner/metrics all green).
      forbidNonWhitelisted: true,
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
  // The OpenAPI JSON route is gated by the SAME predicate (audit A3-6):
  // serving it unconditionally made the production docs gate cosmetic —
  // the full route table, DTO schemas, and auth annotations are public
  // recon. The web developer portal fetches the document at build time,
  // not from a production runtime.
  if (!isProduction() || process.env.ENABLE_API_DOCS === 'true') {
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup('api/v1/docs', app, document);
    const openApiHandler: express.RequestHandler = (_req, res) => {
      res.json(buildOpenApiDocument(app));
    };
    app.getHttpAdapter().getInstance().get('/api/v1/openapi.json', openApiHandler);
  }

  app.enableShutdownHooks();
}
