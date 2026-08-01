import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

const SECRET = 'test-webhook-secret';

function sign(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

/**
 * Webhook HMAC verification against a real HTTP listener. The payments
 * driver is forced to sandbox (credentialed) so signature checks are active;
 * the stub SMS driver exercises the development bypass.
 */
describe('Provider webhooks (e2e)', () => {
  let app: NestExpressApplication;
  let base: string;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.WEBHOOK_SIGNING_SECRET = SECRET;
    process.env.PAYMENT_DRIVER = 'sandbox';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_xxx';
    process.env.FLUTTERWAVE_SECRET_KEY = 'flw_test_xxx';
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(app);
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}/api/v1/integrations/webhooks`;
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...savedEnv };
  });

  async function postWebhook(provider: string, rawBody: string, headers: Record<string, string> = {}) {
    return fetch(`${base}/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody
    });
  }

  it('accepts a correctly signed webhook', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } });
    const res = await postWebhook('paystack', raw, { 'x-paystack-signature': sign(raw) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ received: true, provider: 'paystack' });
    expect(body.data.duplicate).toBeUndefined();
  });

  it('accepts the generic header and sha256= prefix', async () => {
    const raw = JSON.stringify({ event: 'transfer.success', data: { reference: 'ref-2' } });
    const res = await postWebhook('paystack', raw, { 'x-webhook-signature': `sha256=${sign(raw)}` });
    expect(res.status).toBe(201);
  });

  it('rejects missing and invalid signatures', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-3' } });
    expect((await postWebhook('paystack', raw)).status).toBe(401);
    expect((await postWebhook('paystack', raw, { 'x-paystack-signature': 'deadbeef' })).status).toBe(401);
    // Signature over a different body must not verify (tamper resistance).
    const signed = sign(raw);
    const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-3', amount: 1 } });
    expect((await postWebhook('paystack', tampered, { 'x-paystack-signature': signed })).status).toBe(401);
  });

  it('treats replays of the exact signed payload as idempotent duplicates', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-replay' } });
    const headers = { 'x-paystack-signature': sign(raw) };
    const first = await (await postWebhook('paystack', raw, headers)).json();
    expect(first.data.duplicate).toBeUndefined();
    const replay = await postWebhook('paystack', raw, headers);
    expect(replay.status).toBe(201);
    const replayBody = await replay.json();
    expect(replayBody.data.duplicate).toBe(true);
  });

  it('allows unsigned webhooks only for stub drivers outside production', async () => {
    const raw = JSON.stringify({ event: 'sms.delivered' });
    const res = await postWebhook('termii', raw);
    expect(res.status).toBe(201);
    // Unknown providers are still rejected.
    expect((await postWebhook('unknown-provider', raw)).status).toBe(404);
  });
});
