import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

/**
 * GAP-C03 / GAP-H01 route-level contract: POST /api/v1/internal/events is
 * the dedicated event-gw ingress. Boots the real AppModule so the route
 * registration, the global prefix, the ValidationPipe envelope contract
 * and the InternalTokenGuard fail-closed semantics are pinned end to end.
 * (Unit-level token/envelope/replay semantics live in
 * src/modules/integrations/internal-events.controller.spec.ts.)
 */
describe('POST /api/v1/internal/events (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;

  afterAll(async () => {
    await app?.close();
    delete process.env.EVENTGW_INTERNAL_TOKEN;
  });

  it('enforces the token + envelope contract over HTTP', async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const envelope = {
      provider: 'termii',
      eventId: 'evt-e2e-1',
      receivedAt: '2025-01-15T10:30:00.000Z',
      payload: { event: 'sms.delivered', id: 'msg-1' }
    };
    const post = (token?: string, body: unknown = envelope) =>
      fetch(`${base}/api/v1/internal/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-internal-token': token } : {})
        },
        body: JSON.stringify(body)
      });

    // Unconfigured API -> fail-closed 503 even with a token presented.
    delete process.env.EVENTGW_INTERNAL_TOKEN;
    expect((await post('anything')).status).toBe(503);

    process.env.EVENTGW_INTERNAL_TOKEN = 'e2e-token';
    // Missing token -> 401; wrong token -> 401.
    expect((await post()).status).toBe(401);
    expect((await post('wrong')).status).toBe(401);
    // Malformed envelope (missing eventId) -> 400.
    expect(
      (
        await post('e2e-token', {
          provider: 'termii',
          receivedAt: '2025-01-15T10:30:00.000Z',
          payload: {}
        })
      ).status
    ).toBe(400);
    // Smuggled top-level field (e.g. a spoofed provider signature) -> 400.
    expect((await post('e2e-token', { ...envelope, signature: 'spoofed' })).status).toBe(400);
    // Valid envelope + correct token -> accepted.
    const ok = await post('e2e-token');
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { data: { received: boolean; duplicate?: boolean } };
    expect(okBody.data.received).toBe(true);
    expect(okBody.data.duplicate).toBeUndefined();
    // Exact replay -> idempotent duplicate (no re-driven side effects).
    const replay = await post('e2e-token');
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as { data: { duplicate?: boolean } };
    expect(replayBody.data.duplicate).toBe(true);
  }, 60_000);
});
