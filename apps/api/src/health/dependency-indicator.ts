import type { Redis } from 'ioredis';
import type pg from 'pg';

/**
 * Readiness dependency registry (observability plan §A.5). Each indicator
 * knows whether it is configured (env/driver present — lazy driver imports
 * happen upstream in the persistence providers) and how to probe itself.
 *
 * Contract: `skipped` (not configured) never degrades readiness; a
 * configured dependency that fails its check degrades it.
 */
export interface DependencyIndicator {
  readonly name: string;
  configured(): boolean;
  check(): Promise<void>;
}

/** Injection token for the indicator registry (multi-provider). */
export const DEPENDENCY_INDICATORS = 'DEPENDENCY_INDICATORS';

export type DependencyStatus = 'up' | 'down' | 'skipped';

export interface DependencyReport {
  name: string;
  status: DependencyStatus;
  latencyMs: number;
}

const PROBE_TIMEOUT_MS = 1000;

/** PostgreSQL readiness probe (`SELECT 1` against the injected pool). */
export class PgDependencyIndicator implements DependencyIndicator {
  readonly name = 'database';
  constructor(private readonly pool: pg.Pool | null) {}
  configured(): boolean {
    return this.pool !== null;
  }
  async check(): Promise<void> {
    await this.pool!.query('SELECT 1');
  }
}

/** Redis readiness probe (`PING` against the injected client). */
export class RedisDependencyIndicator implements DependencyIndicator {
  readonly name = 'redis';
  constructor(private readonly redis: Redis | null) {}
  configured(): boolean {
    return this.redis !== null;
  }
  async check(): Promise<void> {
    await this.redis!.ping();
  }
}

/**
 * Probes every configured indicator with a timeout; unconfigured indicators
 * report `skipped` with zero latency and never fail the probe.
 */
export async function evaluateDependencies(
  indicators: DependencyIndicator[],
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyReport[]> {
  return Promise.all(
    indicators.map(async (indicator) => {
      if (!indicator.configured()) {
        return { name: indicator.name, status: 'skipped' as const, latencyMs: 0 };
      }
      const startedAt = process.hrtime.bigint();
      try {
        await Promise.race([
          indicator.check(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('probe timeout')), timeoutMs)
          )
        ]);
        return {
          name: indicator.name,
          status: 'up' as const,
          latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)
        };
      } catch {
        return {
          name: indicator.name,
          status: 'down' as const,
          latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)
        };
      }
    })
  );
}
