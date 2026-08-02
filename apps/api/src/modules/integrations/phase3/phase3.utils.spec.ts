import { describe, expect, it } from 'vitest';
import {
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
