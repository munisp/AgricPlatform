/**
 * PostgreSQL pool sizing + statement safety bounds (WP-G7, V3 audit
 * finding A). Previously the pool was created with ONLY a connection
 * string, so a stuck query could hold a connection indefinitely and exhaust
 * the (unbounded-default) pool. Every knob is env-overridable; an unset,
 * empty, non-numeric or non-positive value falls back to the default.
 *
 * Default rationale:
 * - PG_POOL_MAX=10: node-postgres' own default; sized for a single API
 *   replica against the compose Postgres (max_connections=100). Scale by
 *   replica count, not per-process, when raising it.
 * - PG_IDLE_TIMEOUT_MS=30s: returns idle clients to the server quickly so
 *   replicas do not pin connections they are not using.
 * - PG_CONN_TIMEOUT_MS=5s: matches the shared outbound HTTP timeout
 *   (modules/integrations/drivers/http.ts PROVIDER_TIMEOUT_MS) — an
 *   unreachable database must fail fast, not hang request handlers.
 * - PG_STATEMENT_TIMEOUT_MS=30s: the request paths are OLTP point reads /
 *   small writes; the slowest legitimate queries are the admin-only
 *   analytics mart exports (full-table scans in
 *   analytics-star.pg-repository.ts), which are still expected to complete
 *   in seconds at platform scale. 30s bounds a runaway query without
 *   cutting those exports. Raise via the env var if mart exports ever
 *   legitimately exceed it.
 * - PG_QUERY_TIMEOUT_MS: client-side socket timeout, defaulting to
 *   statement_timeout + 5s of slack so Postgres cancels first and returns
 *   a clean error instead of the client killing the connection. Set
 *   explicitly to override the slack.
 *
 * statement_timeout is enforced server-side (sent as a startup parameter),
 * query_timeout client-side; both are supported by pg >= 8.10 (lockfile:
 * pg 8.22.0).
 */
export interface PgPoolConfig {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
}

export const PG_POOL_DEFAULT_MAX = 10;
export const PG_POOL_DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const PG_POOL_DEFAULT_CONN_TIMEOUT_MS = 5_000;
export const PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
/** Slack added to statement_timeout to derive the default query_timeout. */
export const PG_QUERY_TIMEOUT_SLACK_MS = 5_000;

/** Positive-integer env parse; unset/empty/invalid/non-positive -> fallback. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolvePgPoolConfig(env: NodeJS.ProcessEnv = process.env): PgPoolConfig {
  const statementTimeout = positiveInt(
    env.PG_STATEMENT_TIMEOUT_MS,
    PG_POOL_DEFAULT_STATEMENT_TIMEOUT_MS
  );
  return {
    max: positiveInt(env.PG_POOL_MAX, PG_POOL_DEFAULT_MAX),
    idleTimeoutMillis: positiveInt(env.PG_IDLE_TIMEOUT_MS, PG_POOL_DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: positiveInt(env.PG_CONN_TIMEOUT_MS, PG_POOL_DEFAULT_CONN_TIMEOUT_MS),
    statement_timeout: statementTimeout,
    query_timeout: positiveInt(env.PG_QUERY_TIMEOUT_MS, statementTimeout + PG_QUERY_TIMEOUT_SLACK_MS)
  };
}
