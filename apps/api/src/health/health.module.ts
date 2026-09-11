import { Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import {
  AUTHORIZATION_CHECK,
  type AuthorizationCheck
} from '../common/auth/authorization-check.driver.js';
import {
  WORKFLOW_ORCHESTRATOR,
  type WorkflowOrchestrator
} from '../common/orchestration/workflow-orchestrator.driver.js';
import { EVENT_BUS, type EventBus } from '../core/events/event-bus.driver.js';
import { PG_POOL, REDIS_CLIENT } from '../database/persistence.tokens.js';
import { IntegrationsModule } from '../modules/integrations/integrations.module.js';
import {
  DEPENDENCY_INDICATORS,
  PgDependencyIndicator,
  RedisDependencyIndicator,
  type DependencyIndicator
} from './dependency-indicator.js';
import { HealthController } from './health.controller.js';
import {
  authzProbe,
  eventBusProbe,
  INFRA_DRIVER_PROBES,
  orchestratorProbe,
  type InfraDriverProbe
} from './infra-driver-registry.js';
import { ModuleHealthService } from './module-health.service.js';

/**
 * Health/readiness endpoints (observability plan §A.5). The persistence
 * drivers are optional (in-memory mode injects null) and lazily created by
 * the persistence providers, so no pg/Redis connection is opened unless the
 * corresponding env URL exists.
 *
 * Stage 27 (WP-G10): the infra-driver registry binds the globally-provided
 * middleware drivers (event bus, workflow orchestrator, authorization
 * check — CoreModule is @Global) so /health/ready can list them with
 * degraded-not-down semantics.
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
    },
    {
      provide: INFRA_DRIVER_PROBES,
      useFactory: (
        eventBus: EventBus | undefined,
        orchestrator: WorkflowOrchestrator | undefined,
        authz: AuthorizationCheck | undefined
      ): InfraDriverProbe[] =>
        [
          eventBus ? eventBusProbe(eventBus) : undefined,
          orchestrator ? orchestratorProbe(orchestrator) : undefined,
          authz ? authzProbe(authz) : undefined
        ].filter((probe): probe is InfraDriverProbe => probe !== undefined),
      inject: [
        { token: EVENT_BUS, optional: true },
        { token: WORKFLOW_ORCHESTRATOR, optional: true },
        { token: AUTHORIZATION_CHECK, optional: true }
      ]
    }
  ]
})
export class HealthModule {}
