import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pg.Pool must never open a real socket in unit tests — the constructor
// arguments are captured so the WP-G7 safety bounds can be asserted.
const poolConstructor = vi.fn();
vi.mock('pg', () => {
  class Pool {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      poolConstructor(options);
      this.options = options;
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool }, Pool };
});

import { createPgPool, PgPoolProvider, pgPoolStats } from './pg-pool.provider.js';
import type pg from 'pg';

const DATABASE_URL = 'postgresql://agric:agric@localhost:5432/agric_platform';

describe('createPgPool (WP-G7)', () => {
  beforeEach(() => {
    poolConstructor.mockClear();
  });

  it('returns null in in-memory mode (no DATABASE_URL)', () => {
    expect(createPgPool({ NODE_ENV: 'test' })).toBeNull();
    expect(poolConstructor).not.toHaveBeenCalled();
  });

  it('builds the pool with the default safety bounds when no PG_* overrides are set', () => {
    createPgPool({ NODE_ENV: 'production', DATABASE_URL });
    expect(poolConstructor).toHaveBeenCalledTimes(1);
    expect(poolConstructor.mock.calls[0][0]).toEqual({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000
    });
  });

  it('passes env overrides through to pg.Pool', () => {
    createPgPool({
      NODE_ENV: 'production',
      DATABASE_URL,
      PG_POOL_MAX: '25',
      PG_IDLE_TIMEOUT_MS: '10000',
      PG_CONN_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '60000',
      PG_QUERY_TIMEOUT_MS: '65000'
    });
    expect(poolConstructor.mock.calls[0][0]).toEqual({
      connectionString: DATABASE_URL,
      max: 25,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 60_000,
      query_timeout: 65_000
    });
  });

  it('ignores invalid overrides (fail-safe to defaults)', () => {
    createPgPool({ NODE_ENV: 'production', DATABASE_URL, PG_POOL_MAX: 'banana' });
    expect(poolConstructor.mock.calls[0][0]).toMatchObject({ max: 10 });
  });
});

describe('PgPoolProvider lifecycle (WP-G7)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates the pool from process.env and closes it on module destroy', async () => {
    poolConstructor.mockClear();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
    const provider = new PgPoolProvider();
    expect(provider.pool).not.toBeNull();
    const end = vi.spyOn(provider.pool!, 'end');
    await provider.onModuleDestroy();
    expect(end).toHaveBeenCalled();
  });

  it('exposes null in in-memory mode', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', '');
    const provider = new PgPoolProvider();
    expect(provider.pool).toBeNull();
  });

  it('pgPoolStats reads the node-postgres occupancy counters', () => {
    const fake = { totalCount: 7, idleCount: 5, waitingCount: 2 } as unknown as pg.Pool;
    expect(pgPoolStats(fake)).toEqual({ total: 7, idle: 5, waiting: 2 });
  });
});
