import {
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
  UseGuards
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type pg from 'pg';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { PG_POOL } from '../database/persistence.tokens.js';
import { pgPoolStats } from '../database/pg/pg-pool.provider.js';
import { TelemetryService } from '../common/telemetry/telemetry.service.js';
import { IntegrationsService } from '../modules/integrations/integrations.service.js';
import {
  DEPENDENCY_INDICATORS,
  evaluateDependencies,
  type DependencyIndicator,
  type DependencyStatus
} from './dependency-indicator.js';
import {
  degradedDrivers,
  evaluateInfraDrivers,
  INFRA_DRIVER_PROBES,
  type DegradedDriver,
  type InfraDriverProbe
} from './infra-driver-registry.js';
import { ModuleHealthService } from './module-health.service.js';

/** Legacy persistence block status (kept for the existing readiness consumers). */
type PersistenceStatus = 'up' | 'down' | 'disabled';

/**
 * REQUIRED readiness dependencies: a configured-and-down postgres or redis
 * fails the probe (503). Every other dependency and every infra driver is
 * OPTIONAL — degraded ones are listed in degraded[] under a 200 response
 * (Stage 27 WP-G10 degraded-not-down semantics). Unconfigured/skipped
 * dependencies and stub drivers report 'disabled', never 'down'.
 */
const REQUIRED_DEPENDENCIES: ReadonlySet<string> = new Set(['database', 'redis']);

function toPersistenceStatus(status: DependencyStatus | undefined): PersistenceStatus {
  if (status === 'skipped' || status === undefined) {
    return 'disabled';
  }
  return status;
}

@ApiTags('health')
@Controller('health')
// The guard is a no-op on routes without @Roles metadata, so the probe
// endpoints stay public while sensitive diagnostics can be locked down.
@UseGuards(RolesGuard)
export class HealthController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly moduleHealth: ModuleHealthService,
    private readonly telemetry: TelemetryService,
    @Optional()
    @Inject(DEPENDENCY_INDICATORS)
    private readonly dependencies: DependencyIndicator[] = [],
    // WP-G7: pool occupancy (total/idle/waiting) on the readiness payload;
    // null in in-memory mode. Diagnostic counters only — never part of the
    // up/down verdict.
    @Optional()
    @Inject(PG_POOL)
    private readonly pgPool: pg.Pool | null = null,
    @Optional()
    @Inject(INFRA_DRIVER_PROBES)
    private readonly driverProbes: InfraDriverProbe[] = []
  ) {}

  @Get()
  @ApiOperation({ summary: 'Overall API health' })
  health() {
    return {
      status: 'ok',
      service: '@agric-platform/api',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok' };
  }

  // Admin-only (G14): the per-module matrix discloses internal topology,
  // backlog depths and integration health — useful recon for an attacker.
  @Get('modules')
  @Roles('admin')
  @ApiOperation({
    summary:
      'Per-module readiness matrix (Wave P): cheap probes only — connectivity pings ' +
      'and backlog counters (outbox pending/dead-lettered, notification queue depth, ' +
      'integration adapter health, feature-flag count).'
  })
  async modules() {
    return this.moduleHealth.report();
  }

  @Get('ready')
  @ApiOperation({
    summary:
      'Readiness probe: integration adapters, the dependency indicator registry ' +
      '(plan §A.5) and the infra-driver registry (WP-G10: event-bus, orchestrator, ' +
      'authz). Degraded OPTIONAL drivers/integrations return 200 with a degraded[] ' +
      'listing; only a configured-and-down REQUIRED dependency (postgres, redis) ' +
      'fails the probe with 503. Skipped dependencies and stub drivers report ' +
      "'disabled', never 'down'."
  })
  async ready() {
    // WP-G10: one span per readiness evaluation. tenant.id is merged by
    // TelemetryService when a tenant scope is active (probes are usually
    // anonymous, in which case no tenant attribute is emitted).
    return this.telemetry.withSpan('health.ready', { 'health.probe': 'ready' }, async () => {
      const statuses = this.integrations.list();
      const dependencies = await evaluateDependencies(this.dependencies);
      const drivers = await evaluateInfraDrivers(this.driverProbes);
      const byName = new Map(dependencies.map((dep) => [dep.name, dep.status]));
      // Backwards-compatible block from the persistence wave: same information,
      // rendered from the registry ('skipped' reads as the legacy 'disabled').
      const persistence: { database: PersistenceStatus; redis: PersistenceStatus } = {
        database: toPersistenceStatus(byName.get('database')),
        redis: toPersistenceStatus(byName.get('redis'))
      };

      // REQUIRED dependencies fail the probe outright — a configured
      // postgres/redis that is down means the API cannot serve reads/writes.
      const requiredDown = dependencies.filter(
        (dep) => REQUIRED_DEPENDENCIES.has(dep.name) && dep.status === 'down'
      );
      if (requiredDown.length > 0) {
        throw new ServiceUnavailableException(
          `Readiness failed: required ${requiredDown
            .map((dep) => dep.name)
            .join(', ')} dependenc${requiredDown.length === 1 ? 'y is' : 'ies are'} down.`
        );
      }

      // Everything else is OPTIONAL: degraded, never down.
      const degraded: DegradedDriver[] = [
        ...statuses
          .filter((status) => !status.healthy)
          .map((status) => ({
            name: `integration:${status.provider}`,
            reason: status.notes ?? `${status.provider} (${status.capability}) is unhealthy.`
          })),
        ...dependencies
          .filter((dep) => dep.status === 'down' && !REQUIRED_DEPENDENCIES.has(dep.name))
          .map((dep) => ({ name: dep.name, reason: 'Dependency check failed.' })),
        ...degradedDrivers(drivers)
      ];
      return {
        status: degraded.length > 0 ? ('degraded' as const) : ('ok' as const),
        integrations: statuses,
        persistence,
        pgPool: this.pgPool ? pgPoolStats(this.pgPool) : ('disabled' as const),
        dependencies,
        drivers,
        degraded
      };
    });
  }
}
