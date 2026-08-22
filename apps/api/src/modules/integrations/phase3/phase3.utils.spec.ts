import { describe, expect, it } from 'vitest';
import {
  assertProductionPhase3WebhookTokens,
  assertWebhookToken,
  normaliseNin,
  normalisePhone,
  payloadDedupeKey,
  sha256
} from './phase3.utils.js';

describe('phase3 utils', () => {
  it('normalises identity values before hashing', () => {
    expect(normalisePhone('+234 803 111 2222')).toBe('2348031112222');
    expect(normaliseNin(' 1234 abc ')).toBe('1234ABC');
    expect(sha256('x')).toHaveLength(64);
    expect(payloadDedupeKey({ a: 1 })).toBe(payloadDedupeKey({ a: 1 }));
  });

  it('webhook gate accepts the configured token (timing-safe)', () => {
    const env = { OFN_WEBHOOK_TOKEN: 'secret-1' };
    expect(() => assertWebhookToken('ofn', 'secret-1', env)).not.toThrow();
    expect(() => assertWebhookToken('ofn', 'wrong----', env)).toThrow(/Invalid webhook token/);
    expect(() => assertWebhookToken('ofn', undefined, env)).toThrow(/Invalid webhook token/);
  });

  it('webhook gate is open outside production when unconfigured (stub posture)', () => {
    expect(() => assertWebhookToken('farmos', undefined, {}, false)).not.toThrow();
  });

  it('webhook gate fails closed in production when unconfigured', () => {
    expect(() => assertWebhookToken('lender', 'anything', {}, true)).toThrow(/not configured/);
  });
});

describe('assertProductionPhase3WebhookTokens (audit A3-5)', () => {
  const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

  it('is a no-op outside production, even with weak tokens', () => {
    expect(() =>
      assertProductionPhase3WebhookTokens({ NODE_ENV: 'development', OFN_WEBHOOK_TOKEN: 'x' })
    ).not.toThrow();
  });

  it('allows unset tokens in production (per-request guard fails closed instead)', () => {
    expect(() => assertProductionPhase3WebhookTokens(PROD)).not.toThrow();
  });

  it.each(['FARMOS', 'LITEFARM', 'OFN', 'LENDER'])(
    'rejects a 1-character %s_WEBHOOK_TOKEN in production',
    (system) => {
      expect(() =>
        assertProductionPhase3WebhookTokens({ ...PROD, [`${system}_WEBHOOK_TOKEN`]: 'x' })
      ).toThrow(new RegExp(`${system}_WEBHOOK_TOKEN`));
    }
  );

  it('enforces the 16-char floor at the boundary', () => {
    expect(() =>
      assertProductionPhase3WebhookTokens({ ...PROD, OFN_WEBHOOK_TOKEN: 't'.repeat(15) })
    ).toThrow(/OFN_WEBHOOK_TOKEN/);
    expect(() =>
      assertProductionPhase3WebhookTokens({ ...PROD, OFN_WEBHOOK_TOKEN: 't'.repeat(16) })
    ).not.toThrow();
  });

  it('accepts strong tokens for every system in production', () => {
    expect(() =>
      assertProductionPhase3WebhookTokens({
        ...PROD,
        FARMOS_WEBHOOK_TOKEN: 'f'.repeat(24),
        LITEFARM_WEBHOOK_TOKEN: 'l'.repeat(24),
        OFN_WEBHOOK_TOKEN: 'o'.repeat(24),
        LENDER_WEBHOOK_TOKEN: 'n'.repeat(24)
      })
    ).not.toThrow();
  });
});
