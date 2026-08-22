import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertAtCallbackIp,
  assertAtCallbackToken,
  atCallbackIpAllowlist,
  AT_CALLBACK_TOKEN_MIN_LENGTH,
  missingAtCallbackConfig,
  weakAtCallbackToken
} from './at-callback.utils.js';

// Meets the Stage-24 production strength floor (≥32 chars, not a placeholder).
const STRONG_TOKEN = 'test-callback-token-0123456789abcdef';
const TOKEN_ENV = { AT_CALLBACK_TOKEN: STRONG_TOKEN } as unknown as NodeJS.ProcessEnv;

describe('assertAtCallbackToken (audit C2-3)', () => {
  it('rejects a missing token with 401 when one is configured', () => {
    expect(() => assertAtCallbackToken(undefined, TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
  });

  it('rejects a wrong token with 401 (including same-prefix and length-mismatch guesses)', () => {
    expect(() => assertAtCallbackToken('wrong-token', TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
    expect(() => assertAtCallbackToken(`${STRONG_TOKEN}-x`, TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
    expect(() => assertAtCallbackToken('test-callback', TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
  });

  it('accepts the exact configured token outside production', () => {
    expect(() => assertAtCallbackToken(STRONG_TOKEN, TOKEN_ENV, false)).not.toThrow();
  });

  it('accepts the exact configured token in production', () => {
    expect(() => assertAtCallbackToken(STRONG_TOKEN, TOKEN_ENV, true)).not.toThrow();
  });

  it('refuses published placeholders / weak configured tokens in production (Stage 24, A3-1)', () => {
    for (const weak of ['replace-me', 'local-development-only', 'short']) {
      const env = { AT_CALLBACK_TOKEN: weak } as unknown as NodeJS.ProcessEnv;
      // Even presenting the exact configured value must not authenticate.
      expect(() => assertAtCallbackToken(weak, env, true)).toThrowError(UnauthorizedException);
    }
    expect(STRONG_TOKEN.length).toBeGreaterThanOrEqual(AT_CALLBACK_TOKEN_MIN_LENGTH);
  });

  it('normalises the production default through isProduction (Stage 24, A3-8)', () => {
    // No isProd override: NODE_ENV drives the default via the shared helper.
    expect(() =>
      assertAtCallbackToken('anything', { NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    ).toThrowError(UnauthorizedException);
    expect(() =>
      assertAtCallbackToken(undefined, { NODE_ENV: 'development' } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it('fails closed in production when no token is configured', () => {
    expect(() => assertAtCallbackToken('anything', {} as NodeJS.ProcessEnv, true)).toThrowError(
      UnauthorizedException
    );
  });

  it('stays open outside production when no token is configured (test/dev posture)', () => {
    expect(() =>
      assertAtCallbackToken(undefined, {} as NodeJS.ProcessEnv, false)
    ).not.toThrow();
  });
});

describe('missingAtCallbackConfig (production boot guard)', () => {
  it('requires AT_CALLBACK_TOKEN when it is absent', () => {
    expect(missingAtCallbackConfig({} as NodeJS.ProcessEnv)).toEqual(['AT_CALLBACK_TOKEN']);
    expect(missingAtCallbackConfig(TOKEN_ENV)).toEqual([]);
  });

  it('treats published placeholders and short tokens as missing (Stage 24, A3-1)', () => {
    for (const weak of ['replace-me', 'local-development-only', '', 'x'.repeat(31)]) {
      const env = { AT_CALLBACK_TOKEN: weak } as unknown as NodeJS.ProcessEnv;
      expect(missingAtCallbackConfig(env)).toEqual(['AT_CALLBACK_TOKEN']);
    }
    expect(
      missingAtCallbackConfig({
        AT_CALLBACK_TOKEN: 'a-strong-token-value-with-32-chars-min'
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual([]);
  });
});

describe('weakAtCallbackToken (Stage 24, A3-1)', () => {
  it('flags unset, empty, placeholder and sub-length tokens', () => {
    expect(weakAtCallbackToken(undefined)).toBe(true);
    expect(weakAtCallbackToken('')).toBe(true);
    expect(weakAtCallbackToken('   ')).toBe(true);
    expect(weakAtCallbackToken('replace-me')).toBe(true);
    expect(weakAtCallbackToken('local-development-only')).toBe(true);
    expect(weakAtCallbackToken('x'.repeat(AT_CALLBACK_TOKEN_MIN_LENGTH - 1))).toBe(true);
    expect(weakAtCallbackToken('x'.repeat(AT_CALLBACK_TOKEN_MIN_LENGTH))).toBe(false);
  });
});

describe('assertAtCallbackIp (optional allowlist)', () => {
  it('is disabled when the allowlist is empty or unset', () => {
    expect(() => assertAtCallbackIp('203.0.113.9', {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() =>
      assertAtCallbackIp(undefined, { AT_CALLBACK_IP_ALLOWLIST: '' } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(atCallbackIpAllowlist({ AT_CALLBACK_IP_ALLOWLIST: ' , ' } as NodeJS.ProcessEnv)).toEqual(
      []
    );
  });

  it('accepts listed IPs and normalises IPv6-mapped IPv4 forms', () => {
    const env = {
      AT_CALLBACK_IP_ALLOWLIST: '203.0.113.9, 198.51.100.4'
    } as unknown as NodeJS.ProcessEnv;
    expect(() => assertAtCallbackIp('203.0.113.9', env)).not.toThrow();
    expect(() => assertAtCallbackIp('::ffff:198.51.100.4', env)).not.toThrow();
  });

  it('rejects unlisted or unknown caller IPs with 403', () => {
    const env = { AT_CALLBACK_IP_ALLOWLIST: '203.0.113.9' } as unknown as NodeJS.ProcessEnv;
    expect(() => assertAtCallbackIp('203.0.113.10', env)).toThrowError(ForbiddenException);
    expect(() => assertAtCallbackIp(undefined, env)).toThrowError(ForbiddenException);
  });
});
