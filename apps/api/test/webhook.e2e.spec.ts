import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';

const SECRET = 'test-webhook-secret';

/** Paystack's native scheme: HMAC-SHA512 hex over the raw body. */
function signSha512(rawBody: string): string {
  return createHmac('sha512', SECRET).update(rawBody).digest('hex');
}

/** Generic scheme (non-payment providers): HMAC-SHA256 hex over the raw body. */
function signSha256(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

/**
 * Webhook signature verification against a real HTTP listener (audit C3:
 * per-provider native schemes). The payments driver is forced to sandbox
 * (credentialed) so signature checks are active; the stub SMS driver
 * exercises the development bypass; mailgun (sandbox) exercises the generic
 * HMAC-SHA256 scheme.
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
    process.env.EMAIL_DRIVER = 'sandbox';
    process.env.MAILGUN_API_KEY = 'mg_test_xxx';
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

  it('accepts a Paystack webhook signed with its native HMAC-SHA512', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } });
    const res = await postWebhook('paystack', raw, { 'x-paystack-signature': signSha512(raw) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ received: true, provider: 'paystack' });
    expect(body.data.duplicate).toBeUndefined();
  });

  it('rejects Paystack webhooks signed with the wrong scheme (SHA-256)', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-wrong-scheme' } });
    const res = await postWebhook('paystack', raw, { 'x-paystack-signature': signSha256(raw) });
    expect(res.status).toBe(401);
  });

  it('accepts the generic HMAC-SHA256 header and sha256= prefix (mailgun)', async () => {
    const raw = JSON.stringify({ event: 'delivered', id: 'msg-2' });
    const res = await postWebhook('mailgun', raw, {
      'x-webhook-signature': `sha256=${signSha256(raw)}`
    });
    expect(res.status).toBe(201);
  });

  it('accepts a Flutterwave webhook with the matching verif-hash', async () => {
    const raw = JSON.stringify({ event: 'charge.completed', data: { id: 9001 } });
    const res = await postWebhook('flutterwave', raw, { 'verif-hash': SECRET });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ received: true, provider: 'flutterwave' });
  });

  it('rejects missing and invalid signatures', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-3' } });
    expect((await postWebhook('paystack', raw)).status).toBe(401);
    expect((await postWebhook('paystack', raw, { 'x-paystack-signature': 'deadbeef' })).status).toBe(401);
    // Flutterwave: missing and mismatched verif-hash are both rejected.
    const flw = JSON.stringify({ event: 'charge.completed', data: { id: 9002 } });
    expect((await postWebhook('flutterwave', flw)).status).toBe(401);
    expect((await postWebhook('flutterwave', flw, { 'verif-hash': 'wrong-hash' })).status).toBe(401);
    // Signature over a different body must not verify (tamper resistance).
    const signed = signSha512(raw);
    const tampered = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-3', amount: 1 } });
    expect((await postWebhook('paystack', tampered, { 'x-paystack-signature': signed })).status).toBe(401);
  });

  it('treats replays of the exact signed payload as idempotent duplicates', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-replay' } });
    const headers = { 'x-paystack-signature': signSha512(raw) };
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
