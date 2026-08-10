import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderConfigError } from '../integrations/drivers/http.js';
import {
  LiveOtpDriver,
  OtpVerificationError,
  StubOtpDriver,
  createOtpDriver,
  stubOtpCode
} from './otp.driver.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OTP driver port (fail-closed)', () => {
  it('stub driver is the default and clearly deterministic', () => {
    const driver = createOtpDriver({});
    expect(driver.name).toBe('stub');
    // Stable per (farmerId, reference) — reproducible in tests and demos.
    expect(stubOtpCode('farmer-1', 'key-1')).toBe(stubOtpCode('farmer-1', 'key-1'));
    expect(stubOtpCode('farmer-1', 'key-1')).toMatch(/^\d{6}$/);
    expect(stubOtpCode('farmer-1', 'key-1')).not.toBe(stubOtpCode('farmer-1', 'key-2'));
    expect(stubOtpCode('farmer-1', 'key-1')).not.toBe(stubOtpCode('farmer-2', 'key-1'));
  });

  it('stub driver exposes the challenge code (labelled dev channel)', () => {
    const driver = new StubOtpDriver();
    expect(driver.challengeCode('farmer-1', 'ref')).toBe(stubOtpCode('farmer-1', 'ref'));
  });

  it('stub driver verifies the deterministic code and rejects others', async () => {
    const driver = new StubOtpDriver();
    await expect(driver.verify('farmer-1', 'ref', stubOtpCode('farmer-1', 'ref'))).resolves.toBeUndefined();
    await expect(driver.verify('farmer-1', 'ref', '000000')).rejects.toBeInstanceOf(OtpVerificationError);
    await expect(driver.verify('farmer-1', 'ref', '')).rejects.toBeInstanceOf(OtpVerificationError);
  });

  it('live driver without provider config fails closed with 503', async () => {
    const driver = createOtpDriver({ OTP_DRIVER: 'live' });
    expect(driver.name).toBe('live');
    await expect(driver.verify('farmer-1', 'ref', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
  });

  it('live driver with config but no integrated client still fails closed with 503', async () => {
    const driver = new LiveOtpDriver('https://otp.example', 'key');
    await expect(driver.verify('farmer-1', 'ref', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(driver.challengeCode()).toBeUndefined();
  });

  it('unknown driver flags fall back to the stub (non-production only)', () => {
    expect(createOtpDriver({ OTP_DRIVER: 'sandbox' }).name).toBe('stub');
    expect(createOtpDriver({ OTP_DRIVER: 'LIVE-ish' }).name).toBe('stub');
  });

  it('aborts boot in production when the OTP driver is stub (publicly computable code)', () => {
    // The stub code derives from a stable, publicly known hash — allowing it
    // in production would make the farmer presence proof forgeable.
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createOtpDriver({ OTP_DRIVER: 'stub' })).toThrow(ProviderConfigError);
    expect(() => createOtpDriver({})).toThrow(/OTP_DRIVER=live/);
    expect(() => createOtpDriver({ OTP_DRIVER: 'sandbox' })).toThrow(ProviderConfigError);
  });

  it('still boots in production with OTP_DRIVER=live (fail-closed 503 driver)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const driver = createOtpDriver({
      OTP_DRIVER: 'live',
      OTP_PROVIDER_URL: 'https://otp.example',
      OTP_PROVIDER_API_KEY: 'key'
    });
    expect(driver.name).toBe('live');
  });
});
