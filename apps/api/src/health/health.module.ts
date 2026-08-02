import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL, REDIS_CLIENT } from '../database/persistence.tokens.js';
import { IntegrationsModule } from '../modules/integrations/integrations.module.js';
import {
  DEPENDENCY_INDICATORS,
  PgDependencyIndicator,
  RedisDependencyIndicator,
  type DependencyIndicator
} from './dependency-indicator.js';
import { HealthController } from './health.controller.js';
import { ModuleHealthService } from './module-health.service.js';

/**
 * Health/readiness endpoints (observability plan §A.5). The persistence
 * drivers are optional (in-memory mode injects null) and lazily created by
 * the persistence providers, so no pg/Redis connection is opened unless the
 * corresponding env URL exists.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [HealthController],
  providers: [
    ModuleHealthService,
    {
      provide: DEPENDENCY_INDICATORS,
      useFactory: (pool: pg.Pool | null, redis: Redis | null): DependencyIndicator[] => [
        new PgDependencyIndicator(pool),
        new RedisDependencyIndicator(redis)
      ],
      inject: [
        { token: PG_POOL, optional: true },
        { token: REDIS_CLIENT, optional: true }
      ]
    }
  ]
})
export class HealthModule {}
