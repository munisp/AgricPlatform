import 'reflect-metadata';
// FIRST import: starts the OpenTelemetry SDK before AppModule (and therefore
// pg/ioredis/kafkajs/express) is evaluated, so auto-instrumentation can hook
// those modules at load. initTelemetry() never throws — telemetry is
// observability, not a money path; a missing collector must not block boot.
import './common/telemetry/telemetry.boot.js';
import { initTelemetry } from './common/telemetry/telemetry.sdk.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { assertProductionAuthConfig } from './common/auth/auth.config.js';
import { assertProductionDriverConfig } from './modules/integrations/adapters.js';
import { assertProductionPartnerApiConfig } from './modules/partner-api/partner-api.config.js';

async function bootstrap(): Promise<void> {
  // First statement: telemetry init (already performed by the boot import
  // above; this is an idempotent safeguard). No boot-fatal OTEL_* assertions
  // by design — absence of a collector must never block boot.
  initTelemetry();
  // Fail closed: refuse to boot a production process that cannot verify
  // bearer tokens or that runs non-stub integration drivers without
  // credentials (docs/security-compliance.md §1/§6).
  assertProductionAuthConfig();
  assertProductionDriverConfig();
  assertProductionPartnerApiConfig();

  // bufferLogs: startup logs are captured until the pino logger is bound.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  // Tests boot with logger:false; only bind pino for real processes.
  if (process.env.NODE_ENV !== 'test') {
    app.useLogger(app.get(Logger));
  }
  configureApp(app);
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
