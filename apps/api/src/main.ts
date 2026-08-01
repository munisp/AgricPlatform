import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
}

void bootstrap();
