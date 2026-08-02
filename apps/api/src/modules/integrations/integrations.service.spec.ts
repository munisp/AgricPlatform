import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('deliverMessage stays on the stub result while drivers are stub', async () => {
    const service = new IntegrationsService();
    const result = await service.deliverMessage('sms', { to: '+234', text: 'hi' });
    expect(result.delivered).toBe(true);
    expect(result.note).toContain('no external network call');
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
});
