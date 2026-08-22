import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * OpenAPI surface gating (audit A3-6): /api/v1/openapi.json must be gated by
 * the SAME predicate as the Swagger UI. Previously the JSON route was
 * registered unconditionally ("always served"), making the production docs
 * gate cosmetic — full route table, DTO schemas and auth annotations were
 * public recon in production.
 *
 * The gate is evaluated inside configureApp (route registration time), so
 * NODE_ENV/ENABLE_API_DOCS are stubbed around that call only — the app
 * itself boots in test mode.
 */
describe('OpenAPI surface gating (e2e)', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  async function bootApp(env: Record<string, string>): Promise<{
    app: NestExpressApplication;
    base: string;
  }> {
    // The app boots in normal test mode (production-mode AppModule init is
    // fail-closed without real OIDC/DB/Redis by design); the docs gate is
    // evaluated inside configureApp, so the environment is stubbed around
    // that call only.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    process.env = { ...savedEnv, ...env };
    try {
      configureApp(app);
    } finally {
      process.env = { ...savedEnv };
    }
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    return { app, base: `http://127.0.0.1:${address.port}` };
  }

  it('serves the docs UI and openapi.json outside production', async () => {
    const { app, base } = await bootApp({ NODE_ENV: 'test' });
    try {
      const json = await fetch(`${base}/api/v1/openapi.json`);
      expect(json.status).toBe(200);
      const doc = (await json.json()) as { openapi?: string };
      expect(doc.openapi).toBeDefined();
      const ui = await fetch(`${base}/api/v1/docs/`);
      expect(ui.status).toBeLessThan(400);
    } finally {
      await app.close();
    }
  });

  it('serves NEITHER route in production when docs are disabled (fail closed)', async () => {
    const { app, base } = await bootApp({ NODE_ENV: 'production', ENABLE_API_DOCS: 'false' });
    try {
      expect((await fetch(`${base}/api/v1/openapi.json`)).status).toBe(404);
      expect((await fetch(`${base}/api/v1/docs/`)).status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves both routes in production when ENABLE_API_DOCS=true (explicit opt-in)', async () => {
    const { app, base } = await bootApp({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' });
    try {
      expect((await fetch(`${base}/api/v1/openapi.json`)).status).toBe(200);
      expect((await fetch(`${base}/api/v1/docs/`)).status).toBeLessThan(400);
    } finally {
      await app.close();
    }
  });
});
