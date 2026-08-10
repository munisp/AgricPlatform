import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
