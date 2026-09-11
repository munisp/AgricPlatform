import { describe, expect, it, vi } from 'vitest';
import { ErrorTrackingService, scrubSentryEvent } from './error-tracking.service.js';

describe('scrubSentryEvent', () => {
  it('redacts headers, phone, and OTP fields at any depth', () => {
    const event = {
      request: {
        url: '/api/v1/auth/otp/verify',
        headers: { authorization: 'Bearer x', cookie: 's=1', 'x-api-key': 'k', accept: 'json' },
        data: { phone: '08031234000', code: '123456', devCode: '123456', token: 't', note: 'ok' }
      },
      user: { phone: '08031234000', id: 'user-1' },
      breadcrumbs: [{ data: { token: 't2' } }]
    };
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request.headers).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      accept: 'json'
    });
    expect(scrubbed.request.data).toEqual({
      phone: '[redacted]',
      code: '[redacted]',
      devCode: '[redacted]',
      token: '[redacted]',
      note: 'ok'
    });
    expect(scrubbed.user.phone).toBe('[redacted]');
    expect(scrubbed.user.id).toBe('user-1');
    expect(scrubbed.breadcrumbs[0].data.token).toBe('[redacted]');
    // Original event must not be mutated.
    expect(event.request.data.code).toBe('123456');
  });

  it('redacts the newer credential keys case-insensitively (audit A3-9)', () => {
    const event = {
      request: {
        headers: {
          'x-at-callback-token': 'at-secret',
          'X-Webhook-Signature': 'sig',
          'x-paystack-signature': 'psig',
          accept: 'json'
        },
        data: {
          'verif-hash': 'flw-hash',
          signingSecret: 's',
          PASSWORD: 'p',
          apiKey: 'k',
          apikey: 'k2',
          NIN: '12345678901',
          note: 'ok'
        }
      }
    };
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.request.headers['x-at-callback-token']).toBe('[redacted]');
    expect(scrubbed.request.headers['X-Webhook-Signature']).toBe('[redacted]');
    expect(scrubbed.request.headers['x-paystack-signature']).toBe('[redacted]');
    expect(scrubbed.request.headers.accept).toBe('json');
    expect(scrubbed.request.data['verif-hash']).toBe('[redacted]');
    expect(scrubbed.request.data.signingSecret).toBe('[redacted]');
    expect(scrubbed.request.data.PASSWORD).toBe('[redacted]');
    expect(scrubbed.request.data.apiKey).toBe('[redacted]');
    expect(scrubbed.request.data.apikey).toBe('[redacted]');
    expect(scrubbed.request.data.NIN).toBe('[redacted]');
    expect(scrubbed.request.data.note).toBe('ok');
  });

  it('scrubs credential fragments embedded in exception message strings (audit A3-9)', () => {
    // ProviderHttpError-style bodies may echo request credentials; object-key
    // filtering alone leaves them untouched.
    const event = {
      exception: {
        values: [
          {
            type: 'ProviderHttpError',
            value:
              "Provider 'paystack' failed with HTTP 500: {\"authorization\":\"Bearer sk-live-abc\",\"detail\":\"bad\"}"
          },
          {
            type: 'Error',
            value: 'callback rejected: token=supersecret123 for /ussd/callback'
          }
        ]
      },
      message: 'plain message without credentials'
    };
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.exception.values[0].value).not.toContain('sk-live-abc');
    expect(scrubbed.exception.values[0].value).toContain('[redacted]');
    expect(scrubbed.exception.values[1].value).not.toContain('supersecret123');
    expect(scrubbed.exception.values[1].value).toContain('token=[redacted]');
    // Benign strings are left untouched.
    expect(scrubbed.message).toBe('plain message without credentials');
  });
});

describe('ErrorTrackingService', () => {
  it('is fully disabled without SENTRY_DSN (no SDK import)', async () => {
    const saved = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      const service = new ErrorTrackingService();
      await service.onModuleInit();
      expect(service.enabled).toBe(false);
      // capture5xx is a no-op and never throws when disabled.
      expect(() =>
        service.capture5xx(new Error('x'), { status: 500 })
      ).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.SENTRY_DSN = saved;
    }
  });

  it('capture5xx ignores sub-500 statuses even when enabled', () => {
    const service = new ErrorTrackingService();
    (service as never as { sentry: unknown }).sentry = { captureException: vi.fn() };
    service.capture5xx(new Error('client'), { status: 400 });
    service.capture5xx(new Error('server'), { status: 503, requestId: 'r1' });
    const sentry = (service as never as { sentry: { captureException: ReturnType<typeof vi.fn> } }).sentry;
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
