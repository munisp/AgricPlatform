import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveOtpDriver, OtpVerificationError } from './otp.driver.js';

/**
 * WP-G17: live OTP vendor client behaviour. The sibling otp.driver.spec.ts
 * covers the stub driver and the production boot ban; this spec covers the
 * vendor client scaffolding with a mocked global fetch.
 */
describe('LiveOtpDriver vendor client (WP-G17)', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves when the vendor confirms the proof', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ valid: true }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://otp.example/verify');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer key');
    // The code travels in the request body only; nothing is logged.
    expect(String(init.body)).toContain('123456');
  });

  it('rejects an invalid proof with OtpVerificationError (not 503)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ valid: false })));
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    await expect(driver.verify('farmer-1', 'ref-1', '000000')).rejects.toBeInstanceOf(
      OtpVerificationError
    );
  });

  it('fails closed with 503 on a malformed vendor response (missing verdict)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' })));
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('fails closed with 503 on vendor HTTP errors and never echoes the OTP code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad code 123456 for farmer', { status: 400 }))
    );
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    const error = await driver.verify('farmer-1', 'ref-1', '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String((error as Error).message)).not.toContain('123456');
  });

  it('retries a transient 5xx exactly once, then resolves', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 502))
      .mockResolvedValueOnce(jsonResponse({ valid: true }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a vendor timeout to 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
        })
      )
    );
    const driver = new LiveOtpDriver('https://otp.example', 'key', 10);
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('opens the circuit breaker after 3 failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    for (let i = 0; i < 3; i += 1) {
      await driver.verify('farmer-1', 'ref-1', '123456').catch(() => undefined);
    }
    expect(driver.circuitOpen).toBe(true);
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    // The open breaker short-circuits: still only 3 network attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed with 503 when unconfigured and exposes no challenge code', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveOtpDriver(undefined, undefined);
    await expect(driver.verify('farmer-1', 'ref-1', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(driver.challengeCode('farmer-1', 'ref-1')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
