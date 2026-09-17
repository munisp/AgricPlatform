import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from './bootstrap.js';

describe('resolveTrustProxy (L-02)', () => {
  it('is off by default and on explicit false-y values', () => {
    expect(resolveTrustProxy({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTrustProxy({ TRUST_PROXY: '' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveTrustProxy({ TRUST_PROXY: '0' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('parses numeric hop counts', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '1' } as NodeJS.ProcessEnv)).toBe(1);
    expect(resolveTrustProxy({ TRUST_PROXY: '2' } as NodeJS.ProcessEnv)).toBe(2);
  });

  it('passes through non-numeric Express trust-proxy values', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'loopback' } as NodeJS.ProcessEnv)).toBe('loopback');
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8' } as NodeJS.ProcessEnv)).toBe('10.0.0.0/8');
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' } as NodeJS.ProcessEnv)).toBe('true');
  });
});
