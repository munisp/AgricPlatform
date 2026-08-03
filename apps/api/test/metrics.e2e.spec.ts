import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * Scrape-endpoint access control (observability wave). Boots the real app
 * and exercises the /metrics surface end to end: Prometheus text format,
 * operational gauges, METRICS_TOKEN bearer auth, admin RBAC fallback and
 * the production fail-closed behaviour (the guard reads NODE_ENV and
 * METRICS_TOKEN at request time, so no separate process is needed).
 */
describe('Metrics endpoint (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1/metrics`;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'test';
  });

  it('serves Prometheus text format including the operational gauges', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('http_requests_total');
    expect(text).toContain('agric_outbox_backlog_records');
    expect(text).toContain('agric_notification_dlq_depth');
    expect(text).toContain('agric_escrow_locked_amount_kobo');
  });

  it('accepts the METRICS_TOKEN scrape credential', async () => {
    process.env.METRICS_TOKEN = 'e2e-scrape-token';
    const res = await fetch(base, { headers: { authorization: 'Bearer e2e-scrape-token' } });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong bearer token with 401 (no silent downgrade)', async () => {
    process.env.METRICS_TOKEN = 'e2e-scrape-token';
    const res = await fetch(base, { headers: { authorization: 'Bearer not-the-token' } });
    expect(res.status).toBe(401);
  });

  it('accepts an admin identity and rejects non-admin identities', async () => {
    const admin = await fetch(base, { headers: { 'x-user-id': 'user-admin' } });
    expect(admin.status).toBe(200);
    const farmer = await fetch(base, { headers: { 'x-user-id': 'user-aisha' } });
    expect(farmer.status).toBe(403);
  });

  it('fails closed for anonymous scrapes in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await fetch(base);
    expect(res.status).toBe(401);
  });

  it('still serves the scrape credential in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.METRICS_TOKEN = 'e2e-scrape-token';
    const res = await fetch(base, { headers: { authorization: 'Bearer e2e-scrape-token' } });
    expect(res.status).toBe(200);
  });
});
