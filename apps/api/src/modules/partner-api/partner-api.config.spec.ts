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

  it('fails closed in production when the sandbox driver is selected (published dev secret)', () => {
    // PARTNER_API_DRIVER unset ⇒ sandbox ⇒ tokens signed with the PUBLISHED
    // PARTNER_API_DEV_SECRET — anyone could mint valid partner tokens.
    expect(() =>
      assertProductionPartnerApiConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_DRIVER=live/);
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'sandbox'
      } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_DRIVER=live/);
  });

  it('fails closed in production when the live driver uses the published dev secret', () => {
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live',
        PARTNER_API_SIGNING_SECRET: PARTNER_API_DEV_SECRET
      } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_SIGNING_SECRET/);
  });

  it('fails closed in production on a short signing secret (audit A3-5)', () => {
    // Partner tokens are HS256 — 'abc' is offline-brute-forceable from any
    // observed token; previously accepted.
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live',
        PARTNER_API_SIGNING_SECRET: 'abc'
      } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_SIGNING_SECRET/);
    // Boundary: 15 rejected, 16 accepted.
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live',
        PARTNER_API_SIGNING_SECRET: 'p'.repeat(15)
      } as NodeJS.ProcessEnv)
    ).toThrow(/at least 16 characters/);
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live',
        PARTNER_API_SIGNING_SECRET: 'p'.repeat(16)
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it('treats NODE_ENV casing variants as production (fail closed)', () => {
    expect(() =>
      assertProductionPartnerApiConfig({ NODE_ENV: 'Production' } as NodeJS.ProcessEnv)
    ).toThrow(/PARTNER_API_DRIVER=live/);
  });

  it('allows production live with a private secret and non-production sandbox', () => {
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'production',
        PARTNER_API_DRIVER: 'live',
        PARTNER_API_SIGNING_SECRET: 'ci-smoke-partner-api-signing-key'
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertProductionPartnerApiConfig({
        NODE_ENV: 'test',
        PARTNER_API_DRIVER: 'live'
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertProductionPartnerApiConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});
