import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { resolvePgPoolConfig } from '../../config/pg-pool.config.js';
import { resolvePersistenceMode } from '../../config/persistence.config.js';

/** Live pool occupancy snapshot (total / idle / waiting clients). */
export interface PgPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/** Reads the node-postgres occupancy counters for the health surface. */
export function pgPoolStats(pool: pg.Pool): PgPoolStats {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

/**
 * Shared pg.Pool lifecycle holder. The pool is only created when
 * DATABASE_URL resolves the persistence mode to 'pg'; in in-memory mode the
 * provider exposes null so repository factories pick the in-memory
 * implementations. The pool is closed with the Nest application.
 *
 * WP-G7: the pool is created with explicit sizing + statement safety bounds
 * (config/pg-pool.config.ts) so a stuck query can no longer hold a
 * connection indefinitely and exhaust the pool.
 */
/**
 * Creates the pool for pg mode (null in in-memory mode). Kept as a plain
 * function — with emitDecoratorMetadata, a constructor parameter on the
 * provider would be picked up as a Nest DI dependency.
 */
export function createPgPool(env: NodeJS.ProcessEnv = process.env): pg.Pool | null {
  if (resolvePersistenceMode(env) !== 'pg') {
    return null;
  }
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ...resolvePgPoolConfig(env)
  });
}

@Injectable()
export class PgPoolProvider implements OnModuleDestroy {
  private readonly logger = new Logger('PgPoolProvider');
  readonly pool: pg.Pool | null = null;

  constructor() {
    this.pool = createPgPool();
    if (this.pool) {
      this.logger.log(
        `pg pool created (max=${this.pool.options.max}, ` +
          `idleTimeoutMillis=${this.pool.options.idleTimeoutMillis}, ` +
          `connectionTimeoutMillis=${this.pool.options.connectionTimeoutMillis}, ` +
          `statement_timeout=${this.pool.options.statement_timeout}, ` +
          `query_timeout=${this.pool.options.query_timeout})`
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('pg pool closed');
    }
  }
}
