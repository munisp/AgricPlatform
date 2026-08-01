import { isProduction } from '../common/auth/auth.config.js';

export type PersistenceMode = 'pg' | 'memory';
export type CacheMode = 'redis' | 'memory';

/**
 * Persistence mode resolution (persistence wave plan §8). Fail-closed in
 * production: NODE_ENV=production without DATABASE_URL aborts boot unless
 * the operator explicitly opts into in-memory persistence.
 */
export function resolvePersistenceMode(env: NodeJS.ProcessEnv = process.env): PersistenceMode {
  if (env.DATABASE_URL) {
    return 'pg';
  }
  if (isProduction(env) && env.ALLOW_INMEMORY_PERSISTENCE !== 'true') {
    throw new Error(
      'FATAL: NODE_ENV=production requires DATABASE_URL so state is persisted in ' +
        'PostgreSQL. Refusing to start with in-memory persistence. Set ' +
        'ALLOW_INMEMORY_PERSISTENCE=true only for break-glass local drills.'
    );
  }
  return 'memory';
}

/**
 * Cache mode resolution, mirroring resolvePersistenceMode for the Redis
 * idempotency/OTP stores (plan §7).
 */
export function resolveCacheMode(env: NodeJS.ProcessEnv = process.env): CacheMode {
  if (env.REDIS_URL) {
    return 'redis';
  }
  if (isProduction(env) && env.ALLOW_INMEMORY_CACHE !== 'true') {
    throw new Error(
      'FATAL: NODE_ENV=production requires REDIS_URL so idempotency keys and OTP ' +
        'challenges are shared across replicas. Refusing to start with the ' +
        'in-memory cache. Set ALLOW_INMEMORY_CACHE=true only for break-glass drills.'
    );
  }
  return 'memory';
}
