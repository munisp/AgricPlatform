import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryWebhookDedupeStore } from '../../database/repositories/webhook-dedupe.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import { ProviderConfigError } from './drivers/http.js';
import { IntegrationsService } from './integrations.service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('IntegrationsService live driver wiring (wave P1)', () => {
  it('keeps stub defaults: no live drivers, deterministic weather fixture', async () => {
    const service = new IntegrationsService();
    expect(service.smsDriver()).toBeUndefined();
    expect(service.whatsappDriver()).toBeUndefined();
    expect(service.emailDriver()).toBeUndefined();
    expect(service.pushDriver()).toBeUndefined();
    expect(service.paymentDriver('paystack')).toBeUndefined();
    expect(service.searchProvider()).toBeUndefined();
    expect(service.weatherProvider()).toBeUndefined();
    const first = await service.weatherSnapshot('Kano');
    const second = await service.weatherSnapshot('Kano');
    expect(first).toEqual(second);
    expect(first.source).toContain('stub');
  });

  it('deliverMessage returns an honest non-delivered stub result while drivers are stub', async () => {
    // Updated expectation: the stub used to fabricate delivered:true, which
    // flipped notifications to 'sent' without any network call. A stub now
    // always reports delivered:false so the retry machinery keeps the
    // message pending.
    const service = new IntegrationsService();
    const result = await service.deliverMessage('sms', { to: '+234', text: 'hi' });
    expect(result.delivered).toBe(false);
    expect(result.driver).toBe('stub');
    expect(result.note).toContain('NOT sent');
  });

  it('deliver() routes through the same live-driver switch (stub → not delivered)', async () => {
    const service = new IntegrationsService();
    const result = await service.deliver('sms', { to: '+234', text: 'hi' });
    expect(result.delivered).toBe(false);
    expect(result.note).toContain('Simulated');
  });

  it('deliver() invokes the live driver when the channel adapter is non-stub', async () => {
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'live-2' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrationsService();
    const result = await service.deliver('sms', { to: '+2348000000001', text: 'hello' });
    expect(result).toMatchObject({ provider: 'termii', providerRef: 'live-2', delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deliver() propagates live-driver failures (never fabricates delivery)', async () => {
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrationsService();
    await expect(service.deliver('sms', { to: '+2348000000001', text: 'hello' })).rejects.toThrow();
  });

  it('deliver() treats the in_app channel as an honest local inbox delivery', async () => {
    const service = new IntegrationsService();
    const result = await service.deliver('in_app', { to: 'user-1', text: 'hi' });
    expect(result.delivered).toBe(true);
    expect(result.note).toContain('In-app');
  });

  it('routes SMS through the live Termii driver when SMS_DRIVER=production', async () => {
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'live-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrationsService();
    const result = await service.deliverMessage('sms', { to: '+2348000000001', text: 'hello' });
    expect(result).toMatchObject({ provider: 'termii', providerRef: 'live-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves the live Open-Meteo weather path with a 15-minute cache', async () => {
    vi.stubEnv('WEATHER_DRIVER', 'production');
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        current: { temperature_2m: 30, relative_humidity_2m: 55, precipitation: 0 },
        daily: { precipitation_sum: [1, 0, 0] }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new IntegrationsService(new InMemoryKeyValueStore());
    const snapshot = await service.weatherSnapshot('Lagos');
    expect(snapshot.source).toContain('Open-Meteo');
    expect(snapshot.temperatureCelsius).toBe(30);
    await service.weatherSnapshot('Lagos');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });

  it('fails closed at boot in production when a live driver lacks credentials', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMS_DRIVER', 'production');
    expect(() => new IntegrationsService()).toThrow(ProviderConfigError);
    expect(() => new IntegrationsService()).toThrow(/TERMII_API_KEY|TWILIO/);
  });

  it('fails closed at boot for live payments without a secret key', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_DRIVER', 'production');
    expect(() => new IntegrationsService()).toThrow(/PAYSTACK_SECRET_KEY/);
  });

  it('boots in production when the live driver is fully configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const service = new IntegrationsService();
    expect(service.smsDriver()).toBeDefined();
  });

  it('Open-Meteo weather needs no credentials even in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEATHER_DRIVER', 'production');
    const service = new IntegrationsService();
    expect(service.weatherProvider()).toBeDefined();
  });

  it('refuses the weather stub fixture in production (503 fail-closed)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const service = new IntegrationsService();
    await expect(service.weatherSnapshot('Kano')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    await expect(service.weatherSnapshot('Kano')).rejects.toThrow(/WEATHER_DRIVER/);
  });

  it('serves a clearly-labelled weather fixture outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const service = new IntegrationsService();
    const snapshot = await service.weatherSnapshot('Kano');
    expect(snapshot.source).toContain('FIXTURE');
    expect(snapshot.source).toContain('not live data');
  });
});

describe('IntegrationsService webhook dedupe (funds-integrity wave)', () => {
  const payload = { event: 'charge.success', data: { reference: 'ref-1' } };

  it('suppresses duplicate webhooks through the injected store', async () => {
    const service = new IntegrationsService();
    const first = await service.recordWebhook('paystack', payload);
    expect(first.duplicate).toBeUndefined();
    const replay = await service.recordWebhook('paystack', payload);
    expect(replay.duplicate).toBe(true);
  });

  it('dedupe survives a service restart when the store is shared (durable port)', async () => {
    // Simulates the pg-backed store: state lives outside the service, so a
    // new instance (restart / second API pod) still sees the receipt.
    const sharedStore = createInMemoryWebhookDedupeStore();
    const before = new IntegrationsService(undefined, sharedStore);
    expect((await before.recordWebhook('paystack', payload)).duplicate).toBeUndefined();
    const after = new IntegrationsService(undefined, sharedStore);
    expect((await after.recordWebhook('paystack', payload)).duplicate).toBe(true);
    // A different payload (different digest) is not suppressed.
    expect(
      (await after.recordWebhook('paystack', { event: 'charge.success', data: { reference: 'ref-2' } }))
        .duplicate
    ).toBeUndefined();
  });
});

describe('IntegrationsService webhook signature schemes (audit C3)', () => {
  const rawBody = (payload: unknown) => Buffer.from(JSON.stringify(payload));
  const payload = { event: 'charge.success', data: { reference: 'ref-1' } };

  describe('paystack (native HMAC-SHA512)', () => {
    beforeEach(() => {
      vi.stubEnv('PAYMENT_DRIVER', 'sandbox');
      vi.stubEnv('PAYSTACK_WEBHOOK_SECRET', 'ps-whsec');
    });

    it('accepts a payload signed with HMAC-SHA512, as Paystack signs it', () => {
      const service = new IntegrationsService();
      const body = rawBody(payload);
      const signature = createHmac('sha512', 'ps-whsec').update(body).digest('hex');
      const digest = service.verifyWebhookSignature('paystack', body, {
        'x-paystack-signature': signature
      });
      expect(digest).toBe(signature);
    });

    it('rejects the wrong scheme (HMAC-SHA256) with 401', () => {
      const service = new IntegrationsService();
      const body = rawBody(payload);
      const sha256Sig = createHmac('sha256', 'ps-whsec').update(body).digest('hex');
      expect(() =>
        service.verifyWebhookSignature('paystack', body, { 'x-paystack-signature': sha256Sig })
      ).toThrow(UnauthorizedException);
      // The generic header is NOT consulted for paystack either.
      expect(() =>
        service.verifyWebhookSignature('paystack', body, { 'x-webhook-signature': sha256Sig })
      ).toThrow(UnauthorizedException);
    });

    it('rejects a missing signature with 401 and a missing secret fail-closed', () => {
      const service = new IntegrationsService();
      const body = rawBody(payload);
      expect(() => service.verifyWebhookSignature('paystack', body, {})).toThrow(
        UnauthorizedException
      );
      vi.stubEnv('PAYSTACK_WEBHOOK_SECRET', '');
      vi.stubEnv('WEBHOOK_SIGNING_SECRET', '');
      expect(() =>
        service.verifyWebhookSignature('paystack', body, {
          'x-paystack-signature': 'ab'.repeat(64)
        })
      ).toThrow(/WEBHOOK_SECRET/);
    });
  });

  describe('flutterwave (static verif-hash)', () => {
    beforeEach(() => {
      vi.stubEnv('PAYMENT_DRIVER', 'sandbox');
      vi.stubEnv('FLUTTERWAVE_WEBHOOK_SECRET', 'flw-verif-hash');
    });

    it('accepts a matching verif-hash header and returns a payload-scoped dedupe digest', () => {
      const service = new IntegrationsService();
      const body = rawBody({ event: 'charge.completed', data: { id: 1 } });
      const digest = service.verifyWebhookSignature('flutterwave', body, {
        'verif-hash': 'flw-verif-hash'
      });
      // The dedupe digest is an internal HMAC of the raw body — NEVER the
      // static verif-hash (identical for every event).
      expect(digest).toBe(
        createHmac('sha256', 'flw-verif-hash').update(body).digest('hex')
      );
      expect(digest).not.toBe('flw-verif-hash');
    });

    it('rejects a mismatched or missing verif-hash with 401', () => {
      const service = new IntegrationsService();
      const body = rawBody(payload);
      expect(() =>
        service.verifyWebhookSignature('flutterwave', body, { 'verif-hash': 'wrong' })
      ).toThrow(UnauthorizedException);
      expect(() => service.verifyWebhookSignature('flutterwave', body, {})).toThrow(
        UnauthorizedException
      );
    });
  });

  describe('generic HMAC-SHA256 scheme (other registry providers)', () => {
    it('still verifies mailgun via the generic sha256 path incl. sha256= prefix', () => {
      vi.stubEnv('EMAIL_DRIVER', 'sandbox');
      vi.stubEnv('MAILGUN_WEBHOOK_SECRET', 'mg-whsec');
      const service = new IntegrationsService();
      const body = rawBody({ event: 'delivered' });
      const signature = createHmac('sha256', 'mg-whsec').update(body).digest('hex');
      expect(
        service.verifyWebhookSignature('mailgun', body, {
          'x-webhook-signature': `sha256=${signature}`
        })
      ).toBe(signature);
      expect(() =>
        service.verifyWebhookSignature('mailgun', body, { 'x-webhook-signature': 'deadbeef' })
      ).toThrow(UnauthorizedException);
    });
  });

  it('keeps the stub + non-production bypass (unsigned, no digest)', () => {
    const service = new IntegrationsService();
    expect(service.verifyWebhookSignature('termii', undefined, {})).toBeUndefined();
  });
});

describe('IntegrationsService webhook crash recovery (audit C2)', () => {
  const payload = { event: 'charge.success', data: { reference: 'ref-1' } };

  it('flags a duplicate whose processing never completed for re-driving', async () => {
    const store = createInMemoryWebhookDedupeStore();
    const service = new IntegrationsService(undefined, store);
    expect((await service.recordWebhook('paystack', payload)).duplicate).toBeUndefined();

    // Processing crashed before markWebhookProcessed: the replay must NOT be
    // answered as a bare duplicate — it asks the caller to re-drive.
    const replay = await service.recordWebhook('paystack', payload);
    expect(replay.duplicate).toBe(true);
    expect(replay.reprocess).toBe(true);

    // After the side effects succeed, the marker suppresses reprocessing.
    await service.markWebhookProcessed('paystack', payload);
    const settled = await service.recordWebhook('paystack', payload);
    expect(settled.duplicate).toBe(true);
    expect(settled.reprocess).toBeUndefined();
  });

  it('reprocessUnprocessedWebhooks drains pending rows and marks them processed', async () => {
    const store = createInMemoryWebhookDedupeStore();
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    const service = new IntegrationsService(undefined, store, events);

    await service.recordWebhook('paystack', payload); // never processed
    const other = { event: 'transfer.success', data: { reference: 'ref-2' } };
    await service.recordWebhook('flutterwave', other);
    await service.markWebhookProcessed('flutterwave', other); // processed: skip

    const result = await service.reprocessUnprocessedWebhooks();
    expect(result).toEqual({ reprocessed: 1, failed: 0 });
    const published = await events.listOutbox();
    expect(published).toHaveLength(1);
    expect(published[0].name).toBe('integration.webhook.received');
    expect(published[0].payload).toMatchObject({ provider: 'paystack' });

    // Drained: nothing left to reprocess.
    expect(await service.reprocessUnprocessedWebhooks()).toEqual({ reprocessed: 0, failed: 0 });
    // The reprocessed row is now answered as a plain duplicate.
    const replay = await service.recordWebhook('paystack', payload);
    expect(replay.reprocess).toBeUndefined();
  });

  it('keeps rows unprocessed when republication fails so the next sweep retries', async () => {
    const store = createInMemoryWebhookDedupeStore();
    const events = {
      publish: async () => {
        throw new Error('bus down');
      }
    } as unknown as DomainEventsService;
    const service = new IntegrationsService(undefined, store, events);

    await service.recordWebhook('paystack', payload);
    const result = await service.reprocessUnprocessedWebhooks();
    expect(result).toEqual({ reprocessed: 0, failed: 1 });
    expect((await store.listUnprocessed()).length).toBe(1);
  });
});
