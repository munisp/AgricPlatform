import { describe, expect, it } from 'vitest';
import {
  assertProductionPartnerApiConfig,
  loadPartnerApiConfig,
  PARTNER_API_DEV_SECRET
} from './partner-api.config.js';

describe('partner API config', () => {
  it('defaults to sandbox with the development secret', () => {
    const config = loadPartnerApiConfig({} as NodeJS.ProcessEnv);
    expect(config.driver).toBe('sandbox');
    expect(config.sandbox).toBe(true);
    expect(config.signingSecret).toBe(PARTNER_API_DEV_SECRET);
  });

  it('uses the configured signing secret', () => {
    const config = loadPartnerApiConfig({
      PARTNER_API_SIGNING_SECRET: 'super-secret'
    } as NodeJS.ProcessEnv);
    expect(config.signingSecret).toBe('super-secret');
  });

  it('live driver without a secret yields an empty secret (boot must fail closed)', () => {
    const config = loadPartnerApiConfig({ PARTNER_API_DRIVER: 'live' } as NodeJS.ProcessEnv);
    expect(config.driver).toBe('live');
    expect(config.sandbox).toBe(false);
    expect(config.signingSecret).toBe('');
  });

  it('fails closed in production when live without a signing secret', () => {
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live'
      } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_SIGNING_SECRET/);
  });

  it('allows production sandbox and non-production live-without-secret', () => {
    expect(() =>
      assertProductionPartnerApiConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'test',
        PARTNER_API_DRIVER: 'live'
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});
