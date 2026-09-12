import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  LiveIdentityDriver,
  StubIdentityDriver,
  createIdentityDriver,
  stubIdentityResult
} from './identity.driver.js';

const NIN = '12345678901';

function verifiedNin(start = 10000000000): string {
  // Deterministically find a NIN the stub verifies.
  for (let candidate = start; candidate < 99999999999; candidate += 1) {
    const nin = String(candidate);
    if (stubIdentityResult(nin).verified) {
      return nin;
    }
  }
  throw new Error('no verifiable stub NIN found');
}

describe('identity.driver stub (wave NINVOUCHER)', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  it('is deterministic — the same NIN always gives the same result', () => {
    expect(stubIdentityResult(NIN)).toEqual(stubIdentityResult(NIN));
  });

  it('labels every result basis: stub (honest provenance)', () => {
    expect(stubIdentityResult(NIN).basis).toBe('stub');
    expect(stubIdentityResult('99999999999').basis).toBe('stub');
  });

  it('derives the verdict from a stable hash, not from the name input', async () => {
    const driver = new StubIdentityDriver();
    const a = await driver.verify({ nin: NIN, fullName: 'Amina Bello' });
    const b = await driver.verify({ nin: NIN, fullName: 'Someone Else' });
    expect(a.verified).toBe(b.verified);
    expect(a.nameMatchScore).toBe(b.nameMatchScore);
  });

  it('never verifies a malformed NIN', () => {
    for (const bad of ['', '123', 'abcdefghijk', '123456789012']) {
      const result = stubIdentityResult(bad);
      expect(result.verified, bad).toBe(false);
      expect(result.nameMatchScore, bad).toBe(0);
    }
  });

  it('verified results carry a plausible name-match score (55–99)', () => {
    const result = stubIdentityResult(verifiedNin());
    expect(result.verified).toBe(true);
    expect(result.nameMatchScore).toBeGreaterThanOrEqual(55);
    expect(result.nameMatchScore).toBeLessThanOrEqual(99);
  });

  it('both verdicts occur across the NIN space (stub is not a silent pass-all)', () => {
    let verifiedCount = 0;
    let rejectedCount = 0;
    for (let candidate = 20000000000; candidate < 20000000040; candidate += 1) {
      if (stubIdentityResult(String(candidate)).verified) {
        verifiedCount += 1;
      } else {
        rejectedCount += 1;
      }
    }
    expect(verifiedCount).toBeGreaterThan(0);
    expect(rejectedCount).toBeGreaterThan(0);
  });

  it('the stub driver is named and labelled stub', async () => {
    const driver = new StubIdentityDriver();
    expect(driver.name).toBe('stub');
    const result = await driver.verify({ nin: verifiedNin(), fullName: 'Amina Bello' });
    expect(result.basis).toBe('stub');
  });
});

describe('identity.driver live (fail-closed, wave NINVOUCHER)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.NODE_ENV;
  });

  it('every call fails closed with 503 when config is missing', async () => {
    const driver = new LiveIdentityDriver(undefined, undefined);
    expect(driver.name).toBe('live');
    await expect(driver.verify({ nin: NIN, fullName: 'Amina Bello' })).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('every call STILL fails closed with 503 when configured (vendor not integrated)', async () => {
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    await expect(driver.verify({ nin: NIN, fullName: 'Amina Bello' })).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('createIdentityDriver defaults to the stub driver', () => {
    expect(createIdentityDriver({}).name).toBe('stub');
  });

  it('createIdentityDriver honours NIN_DRIVER=live outside production', () => {
    expect(createIdentityDriver({ NIN_DRIVER: 'live' }).name).toBe('live');
  });

  it('production boot aborts when NIN_DRIVER=live lacks provider config', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createIdentityDriver({ NIN_DRIVER: 'live' })).toThrow(ProviderConfigError);
  });

  it('production accepts NIN_DRIVER=live with full config (still fails closed per call)', () => {
    process.env.NODE_ENV = 'production';
    const driver = createIdentityDriver({
      NIN_DRIVER: 'LIVE',
      NIN_PROVIDER_URL: 'https://vendor.example',
      NIN_PROVIDER_API_KEY: 'key'
    });
    expect(driver.name).toBe('live');
  });

  it('aborts boot in production when the NIN driver is stub (publicly computable verdict)', () => {
    // The stub verdict derives from a stable, publicly known hash — allowing
    // it in production would let anyone enrol as a "verified" beneficiary.
    // Mirrors the OTP driver boot ban.
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createIdentityDriver({ NIN_DRIVER: 'stub' })).toThrow(ProviderConfigError);
    expect(() => createIdentityDriver({})).toThrow(/NIN_DRIVER=live/);
    expect(() => createIdentityDriver({ NIN_DRIVER: 'sandbox' })).toThrow(ProviderConfigError);
  });

  it('treats NODE_ENV casing variants as production (fail closed)', () => {
    vi.stubEnv('NODE_ENV', 'Production');
    expect(() => createIdentityDriver({})).toThrow(ProviderConfigError);
  });

  it('still boots in production with NIN_DRIVER=live (fail-closed 503 driver)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const driver = createIdentityDriver({
      NIN_DRIVER: 'live',
      NIN_PROVIDER_URL: 'https://vendor.example',
      NIN_PROVIDER_API_KEY: 'key'
    });
    expect(driver.name).toBe('live');
  });
});

describe('LiveIdentityDriver vendor client (WP-G17)', () => {
  const INPUT = { nin: NIN, fullName: 'Amina Bello', dateOfBirth: '1990-01-01' };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a verified vendor response onto the port contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ verified: true, nameMatchScore: 87 }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    const result = await driver.verify(INPUT);
    expect(result).toEqual({ verified: true, nameMatchScore: 87, basis: 'live' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://vendor.example/verify');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer key');
  });

  it('maps a rejected vendor verdict to verified: false (not an error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ verified: false })));
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    const result = await driver.verify(INPUT);
    expect(result.verified).toBe(false);
    expect(result.basis).toBe('live');
    expect(result.nameMatchScore).toBeUndefined();
  });

  it('fails closed with 503 on a malformed vendor response (missing verdict)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' })));
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    await expect(driver.verify(INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed with 503 on vendor HTTP errors and never echoes the NIN', async () => {
    // Vendor error bodies may echo the PII we sent; they must not surface.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`unknown nin ${NIN}`, { status: 400 }))
    );
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    const error = await driver.verify(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String((error as Error).message)).not.toContain(NIN);
  });

  it('retries a transient 5xx exactly once, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 503))
      .mockResolvedValueOnce(jsonResponse({ verified: true, nameMatchScore: 60 }));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    const result = await driver.verify(INPUT);
    expect(result.verified).toBe(true);
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
    const driver = new LiveIdentityDriver('https://vendor.example', 'key', 10);
    await expect(driver.verify(INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('opens the circuit breaker after 3 failures and fails fast', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);
    const driver = new LiveIdentityDriver('https://vendor.example', 'key');
    for (let i = 0; i < 3; i += 1) {
      await driver.verify(INPUT).catch(() => undefined);
    }
    expect(driver.circuitOpen).toBe(true);
    await expect(driver.verify(INPUT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The open breaker short-circuits: still only 3 network attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
