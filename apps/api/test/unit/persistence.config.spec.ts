import { describe, expect, it } from 'vitest';
import {
  resolveCacheMode,
  resolvePersistenceMode
} from '../../src/config/persistence.config.js';

describe('resolvePersistenceMode (fail-closed matrix)', () => {
  it('returns pg when DATABASE_URL is set', () => {
    expect(resolvePersistenceMode({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv)).toBe('pg');
    expect(
      resolvePersistenceMode({
        DATABASE_URL: 'postgres://x',
        NODE_ENV: 'production'
      } as NodeJS.ProcessEnv)
    ).toBe('pg');
  });

  it('returns memory outside production without DATABASE_URL', () => {
    expect(resolvePersistenceMode({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('memory');
    expect(resolvePersistenceMode({} as NodeJS.ProcessEnv)).toBe('memory');
  });

  it('throws in production without DATABASE_URL', () => {
    expect(() => resolvePersistenceMode({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/
    );
  });

  it('honours ALLOW_INMEMORY_PERSISTENCE in production', () => {
    expect(
      resolvePersistenceMode({
        NODE_ENV: 'production',
        ALLOW_INMEMORY_PERSISTENCE: 'true'
      } as NodeJS.ProcessEnv)
    ).toBe('memory');
  });
});

describe('resolveCacheMode (fail-closed matrix)', () => {
  it('returns redis when REDIS_URL is set', () => {
    expect(resolveCacheMode({ REDIS_URL: 'redis://x' } as NodeJS.ProcessEnv)).toBe('redis');
  });

  it('returns memory outside production without REDIS_URL', () => {
    expect(resolveCacheMode({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('memory');
  });

  it('throws in production without REDIS_URL', () => {
    expect(() => resolveCacheMode({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /REDIS_URL/
    );
  });

  it('honours ALLOW_INMEMORY_CACHE in production', () => {
    expect(
      resolveCacheMode({
        NODE_ENV: 'production',
        ALLOW_INMEMORY_CACHE: 'true'
      } as NodeJS.ProcessEnv)
    ).toBe('memory');
  });
});
