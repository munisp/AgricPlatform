import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { assertProductionAuthConfig } from './common/auth/auth.config.js';
import { assertProductionDriverConfig } from './modules/integrations/adapters.js';

async function bootstrap(): Promise<void> {
  // Fail closed: refuse to boot a production process that cannot verify
  // bearer tokens or that runs non-stub integration drivers without
  // credentials (docs/security-compliance.md §1/§6).
  assertProductionAuthConfig();
  assertProductionDriverConfig();

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
