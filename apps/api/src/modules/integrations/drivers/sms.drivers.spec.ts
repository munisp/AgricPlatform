import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError, ProviderHttpError } from './http.js';
import {
  createSmsDriver,
  FailoverSmsDriver,
  TermiiSmsDriver,
  TwilioSmsDriver,
  type SmsDriver
} from './sms.drivers.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TermiiSmsDriver', () => {
  it('sends a plain SMS via /api/sms/send', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'msg-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new TermiiSmsDriver('key', 'AgricNG');
    const result = await driver.sendSms({ to: '+2348000000001', message: 'Hello farmer' });
    expect(result).toMatchObject({ delivered: true, provider: 'termii', providerRef: 'msg-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.ng.termii.com/api/sms/send');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      api_key: 'key',
      to: '+2348000000001',
      from: 'AgricNG',
      sms: 'Hello farmer',
      channel: 'generic'
    });
  });

  it('sends an OTP via /api/sms/otp/send with the pin embedded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'otp-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new TermiiSmsDriver('key', 'AgricNG');
    const result = await driver.sendOtp('+2348000000001', '123456');
    expect(result.providerRef).toBe('otp-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.ng.termii.com/api/sms/otp/send');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ pin: '123456', pin_length: 6, message_type: 'NUMERIC' });
  });

  it('maps 4xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 })));
    const driver = new TermiiSmsDriver('bad', 'AgricNG');
    await expect(driver.sendSms({ to: '+234', message: 'x' })).rejects.toThrow(ProviderHttpError);
  });
});

describe('TwilioSmsDriver', () => {
  it('sends with HTTP basic auth and a form payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sid: 'SM123', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new TwilioSmsDriver('AC1', 'token', '+15005550006');
    const result = await driver.sendSms({ to: '+2348000000001', message: 'Hi' });
    expect(result.providerRef).toBe('SM123');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('AC1:token').toString('base64')}`);
    expect(init.body).toContain('To=%2B2348000000001');
  });

  it('sends OTPs as plain messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sid: 'SM9' }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new TwilioSmsDriver('AC1', 'token', '+15005550006');
    await driver.sendOtp('+2348000000001', '999888');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(decodeURIComponent(init.body as string)).toContain('999888');
  });

  it('maps 5xx responses to ProviderHttpError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const driver = new TwilioSmsDriver('AC1', 'token', '+1');
    await expect(driver.sendSms({ to: '+234', message: 'x' })).rejects.toMatchObject({
      status: 500
    });
  });
});

describe('FailoverSmsDriver', () => {
  const ok = (provider: string): SmsDriver => ({
    name: 'twilio',
    sendSms: vi.fn().mockResolvedValue({
      delivered: true,
      provider,
      driver: 'production',
      providerRef: `${provider}-1`,
      note: 'ok'
    }),
    sendOtp: vi.fn().mockResolvedValue({
      delivered: true,
      provider,
      driver: 'production',
      providerRef: `${provider}-otp`,
      note: 'ok'
    })
  });

  it('falls back to Twilio when Termii raises an HTTP error', async () => {
    const primary: SmsDriver = {
      name: 'termii',
      sendSms: vi.fn().mockRejectedValue(new ProviderHttpError('termii', 503, 'down')),
      sendOtp: vi.fn().mockRejectedValue(new ProviderHttpError('termii', 503, 'down'))
    };
    const fallback = ok('twilio');
    const driver = new FailoverSmsDriver(primary, fallback);
    const result = await driver.sendSms({ to: '+234', message: 'x' });
    expect(result.provider).toBe('twilio');
    expect(fallback.sendSms).toHaveBeenCalledOnce();
  });

  it('does not retry configuration errors on the fallback', async () => {
    const primary: SmsDriver = {
      name: 'termii',
      sendSms: vi.fn().mockRejectedValue(new ProviderConfigError('termii', ['TERMII_API_KEY'])),
      sendOtp: vi.fn()
    };
    const fallback = ok('twilio');
    const driver = new FailoverSmsDriver(primary, fallback);
    await expect(driver.sendSms({ to: '+234', message: 'x' })).rejects.toThrow(ProviderConfigError);
    expect(fallback.sendSms).not.toHaveBeenCalled();
  });
});

describe('createSmsDriver factory (fail closed)', () => {
  it('throws when neither provider is fully configured', () => {
    expect(() => createSmsDriver({})).toThrow(ProviderConfigError);
    expect(() => createSmsDriver({ TERMII_API_KEY: 'k' })).toThrow(/TERMII_SENDER_ID/);
  });

  it('returns the Termii driver when only Termii is configured', () => {
    const driver = createSmsDriver({ TERMII_API_KEY: 'k', TERMII_SENDER_ID: 's' });
    expect(driver).toBeInstanceOf(TermiiSmsDriver);
  });

  it('returns the Twilio driver when only Twilio is configured', () => {
    const driver = createSmsDriver({
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM_NUMBER: '+1'
    });
    expect(driver).toBeInstanceOf(TwilioSmsDriver);
  });

  it('wraps both providers in the failover driver', () => {
    const driver = createSmsDriver({
      TERMII_API_KEY: 'k',
      TERMII_SENDER_ID: 's',
      TWILIO_ACCOUNT_SID: 'AC',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM_NUMBER: '+1'
    });
    expect(driver).toBeInstanceOf(FailoverSmsDriver);
  });
});
