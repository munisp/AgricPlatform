import { describe, expect, it } from 'vitest';
import {
  PG_POOL_DEFAULT_CONN_TIMEOUT_MS,
  PG_POOL_DEFAULT_IDLE_TIMEOUT_MS,
  PG_POOL_DEFAULT_MAX,
  PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS,
  PG_QUERY_TIMEOUT_SLACK_MS,
  resolvePgPoolConfig
} from './pg-pool.config.js';

describe('resolvePgPoolConfig (WP-G7)', () => {
  it('returns safe defaults when no env is set', () => {
    expect(resolvePgPoolConfig({})).toEqual({
      max: PG_POOL_DEFAULT_MAX,
      idleTimeoutMillis: PG_POOL_DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: PG_POOL_DEFAULT_CONN_TIMEOUT_MS,
      statement_timeout: PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS,
      query_timeout: PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS + PG_QUERY_TIMEOUT_SLACK_MS
    });
  });

  it('honours explicit env overrides', () => {
    const config = resolvePgPoolConfig({
      PG_POOL_MAX: '25',
      PG_IDLE_TIMEOUT_MS: '5000',
      PG_CONN_TIMEOUT_MS: '1000',
      PG_STATEMENT_TIMEOUT_MS: '60000',
      PG_QUERY_TIMEOUT_MS: '70000'
    });
    expect(config).toEqual({
      max: 25,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 1000,
      statement_timeout: 60_000,
      query_timeout: 70_000
    });
  });

  it('defaults query_timeout to statement_timeout + slack when only the statement bound is set', () => {
    const config = resolvePgPoolConfig({ PG_STATEMENT_TIMEOUT_MS: '60000' });
    expect(config.statement_timeout).toBe(60_000);
    expect(config.query_timeout).toBe(65_000);
  });

  it('falls back to defaults for empty, non-numeric, fractional or non-positive values', () => {
    for (const bad of ['', 'abc', '1.5', '0', '-10', ' ']) {
      const config = resolvePgPoolConfig({ PG_POOL_MAX: bad });
      expect(config.max).toBe(PG_POOL_DEFAULT_MAX);
    }
    const config = resolvePgPoolConfig({
      PG_IDLE_TIMEOUT_MS: 'nope',
      PG_CONN_TIMEOUT_MS: '-1',
      PG_STATEMENT_TIMEOUT_MS: '0',
      PG_QUERY_TIMEOUT_MS: 'x'
    });
    expect(config.idleTimeoutMillis).toBe(PG_POOL_DEFAULT_IDLE_TIMEOUT_MS);
    expect(config.connectionTimeoutMillis).toBe(PG_POOL_DEFAULT_CONN_TIMEOUT_MS);
    expect(config.statement_timeout).toBe(PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS);
    // query_timeout default follows the (defaulted) statement timeout.
    expect(config.query_timeout).toBe(
      PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS + PG_QUERY_TIMEOUT_SLACK_MS
    );
  });
});
