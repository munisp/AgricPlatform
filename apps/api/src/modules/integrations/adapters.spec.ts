import { describe, expect, it } from 'vitest';
import {
  ADAPTER_DEFINITIONS,
  assertProductionDriverConfig,
  createAdapter,
  resolveDriver
} from './adapters.js';

const definition = (provider: string) => {
  const found = ADAPTER_DEFINITIONS.find((d) => d.provider === provider);
  if (!found) throw new Error(`missing adapter definition: ${provider}`);
  return found;
};

describe('Integration adapter driver resolution', () => {
  it('defines email, push and Flutterwave adapters', () => {
    expect(definition('mailgun').driverEnv).toBe('EMAIL_DRIVER');
    expect(definition('onesignal').driverEnv).toBe('PUSH_DRIVER');
    expect(definition('flutterwave').driverEnv).toBe('PAYMENT_DRIVER');
    expect(definition('flutterwave').capability).toBe('payments');
  });

  it('maps providers to the canonical driver flags from docs/integration-matrix.md', () => {
    expect(definition('termii').driverEnv).toBe('SMS_DRIVER');
    expect(definition('whatsapp').driverEnv).toBe('WHATSAPP_DRIVER');
    expect(definition('paystack').driverEnv).toBe('PAYMENT_DRIVER');
    expect(definition('moodle').driverEnv).toBe('LMS_DRIVER');
    expect(definition('discourse').driverEnv).toBe('COMMUNITY_DRIVER');
    expect(definition('weather').driverEnv).toBe('WEATHER_DRIVER');
    expect(definition('search').driverEnv).toBe('SEARCH_DRIVER');
  });

  it('honours the canonical driver flag over the legacy provider-prefixed one', () => {
    const env = { SMS_DRIVER: 'sandbox', TERMII_DRIVER: 'production', TERMII_API_KEY: 'k' };
    expect(resolveDriver(definition('termii'), env)).toEqual({ driver: 'sandbox', configured: true });
  });

  it('reports the search backend the query path actually serves (Meilisearch)', () => {
    // Split-brain guard: the status vocabulary must match the backend the
    // search provider factory binds for the same live-mode flag.
    const adapter = createAdapter(definition('search'), {
      SEARCH_DRIVER: 'production',
      MEILISEARCH_API_KEY: 'k'
    });
    const status = adapter.status();
    expect(status.driver).toBe('production');
    expect(status.healthy).toBe(true);
    expect(status.notes).toContain('Meilisearch');
    const sandbox = createAdapter(definition('search'), { MEILISEARCH_API_KEY: 'k' });
    expect(sandbox.status().notes).toContain('Meilisearch');
  });

  it('defaults to stub without flags or credentials, sandbox with credentials', () => {
    expect(resolveDriver(definition('termii'), {})).toEqual({ driver: 'stub', configured: false });
    expect(resolveDriver(definition('termii'), { TERMII_API_KEY: 'k' })).toEqual({
      driver: 'sandbox',
      configured: true
    });
    expect(resolveDriver(definition('mailgun'), { SENDGRID_API_KEY: 'k' })).toEqual({
      driver: 'sandbox',
      configured: true
    });
  });

  it('treats an explicit non-stub driver without credentials as unconfigured', () => {
    const { driver, configured } = resolveDriver(definition('paystack'), { PAYMENT_DRIVER: 'production' });
    expect(driver).toBe('production');
    expect(configured).toBe(false);
    const adapter = createAdapter(definition('paystack'), { PAYMENT_DRIVER: 'production' });
    expect(adapter.status().healthy).toBe(false);
  });

  it('fails loudly in production when non-stub drivers lack credentials', () => {
    expect(() =>
      assertProductionDriverConfig({ NODE_ENV: 'production', PAYMENT_DRIVER: 'production' })
    ).toThrowError(/paystack/);
    expect(() =>
      assertProductionDriverConfig({ NODE_ENV: 'production', SMS_DRIVER: 'sandbox' })
    ).toThrowError(/termii/);
  });

  it('allows production boot when drivers are stub or credentialed', () => {
    expect(() => assertProductionDriverConfig({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertProductionDriverConfig({
        NODE_ENV: 'production',
        PAYMENT_DRIVER: 'sandbox',
        PAYSTACK_SECRET_KEY: 'sk_test',
        FLUTTERWAVE_SECRET_KEY: 'flw_test'
      })
    ).not.toThrow();
    expect(() =>
      assertProductionDriverConfig({ NODE_ENV: 'test', SMS_DRIVER: 'production' })
    ).not.toThrow();
  });

  it('treats Open-Meteo weather as keyless: live driver allowed without credentials, stub stays default', () => {
    expect(resolveDriver(definition('weather'), {})).toEqual({ driver: 'stub', configured: false });
    expect(resolveDriver(definition('weather'), { WEATHER_DRIVER: 'production' })).toEqual({
      driver: 'production',
      configured: true
    });
    expect(() =>
      assertProductionDriverConfig({ NODE_ENV: 'production', WEATHER_DRIVER: 'production' })
    ).not.toThrow();
  });
});
