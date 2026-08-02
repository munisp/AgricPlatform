import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import { createPushDriver, OneSignalPushDriver } from './push.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OneSignalPushDriver', () => {
  it('targets external user ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'notif-1', recipients: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new OneSignalPushDriver('app-id', 'rest-key');
    const result = await driver.send({ userIds: ['user-1'], title: 'Alert', body: 'Rain coming' });
    expect(result).toMatchObject({ delivered: true, providerRef: 'notif-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://onesignal.com/api/v1/notifications');
    expect((init.headers as Record<string, string>).authorization).toBe('Basic rest-key');
    const body = JSON.parse(init.body as string);
    expect(body.app_id).toBe('app-id');
    expect(body.include_external_user_ids).toEqual(['user-1']);
  });

  it('targets segments for broadcasts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'notif-2', recipients: 42 }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new OneSignalPushDriver('app-id', 'rest-key');
    await driver.send({ segments: ['Subscribed Users'], title: 'T', body: 'B' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).included_segments).toEqual(['Subscribed Users']);
  });

  it('rejects sends without a target', async () => {
    const driver = new OneSignalPushDriver('app-id', 'rest-key');
    await expect(driver.send({ title: 'T', body: 'B' })).rejects.toThrow(/at least one/);
  });

  it('maps provider errors to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad app', { status: 400 })));
    const driver = new OneSignalPushDriver('app-id', 'rest-key');
    await expect(
      driver.send({ userIds: ['u'], title: 'T', body: 'B' })
    ).rejects.toThrow(ProviderHttpError);
  });
});

describe('createPushDriver factory (fail closed)', () => {
  it('requires both OneSignal variables', () => {
    expect(() => createPushDriver({})).toThrow(ProviderConfigError);
    expect(() => createPushDriver({ ONESIGNAL_APP_ID: 'a' })).toThrow(/ONESIGNAL_REST_API_KEY/);
  });

  it('builds the driver when both are present', () => {
    expect(
      createPushDriver({ ONESIGNAL_APP_ID: 'a', ONESIGNAL_REST_API_KEY: 'k' })
    ).toBeInstanceOf(OneSignalPushDriver);
  });
});
