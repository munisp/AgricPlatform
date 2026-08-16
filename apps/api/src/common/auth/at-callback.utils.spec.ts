import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertAtCallbackIp,
  assertAtCallbackToken,
  atCallbackIpAllowlist,
  missingAtCallbackConfig
} from './at-callback.utils.js';

const TOKEN_ENV = { AT_CALLBACK_TOKEN: 'test-callback-token' } as unknown as NodeJS.ProcessEnv;

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
    expect(() => assertAtCallbackToken('test-callback-token-x', TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
    expect(() => assertAtCallbackToken('test-callback', TOKEN_ENV, false)).toThrowError(
      UnauthorizedException
    );
  });

  it('accepts the exact configured token outside production', () => {
    expect(() => assertAtCallbackToken('test-callback-token', TOKEN_ENV, false)).not.toThrow();
  });

  it('accepts the exact configured token in production', () => {
    expect(() => assertAtCallbackToken('test-callback-token', TOKEN_ENV, true)).not.toThrow();
  });

  it('fails closed in production when no token is configured', () => {
    expect(() =>
      assertAtCallbackToken('anything', {} as NodeJS.ProcessEnv, true)
    ).toThrowError(UnauthorizedException);
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
