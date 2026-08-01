import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { resolvePersistenceMode } from '../../config/persistence.config.js';

/**
 * Shared pg.Pool lifecycle holder. The pool is only created when
 * DATABASE_URL resolves the persistence mode to 'pg'; in in-memory mode the
 * provider exposes null so repository factories pick the in-memory
 * implementations. The pool is closed with the Nest application.
 */
@Injectable()
export class PgPoolProvider implements OnModuleDestroy {
  private readonly logger = new Logger('PgPoolProvider');
  readonly pool: pg.Pool | null = null;

  constructor() {
    if (resolvePersistenceMode() === 'pg') {
      this.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('pg pool closed');
    }
  }
}
