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
