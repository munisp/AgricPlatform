import { Controller, Get, Inject, Optional, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { IntegrationsService } from '../modules/integrations/integrations.service.js';
import {
  DEPENDENCY_INDICATORS,
  evaluateDependencies,
  type DependencyIndicator,
  type DependencyStatus
} from './dependency-indicator.js';
import { ModuleHealthService } from './module-health.service.js';

/** Legacy persistence block status (kept for the existing readiness consumers). */
type PersistenceStatus = 'up' | 'down' | 'disabled';

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
    @Optional()
    @Inject(DEPENDENCY_INDICATORS)
    private readonly dependencies: DependencyIndicator[] = []
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
      'Readiness probe: integration adapters plus the dependency indicator registry ' +
      '(plan §A.5). Skipped (unconfigured) dependencies never degrade readiness.'
  })
  async ready() {
    const statuses = this.integrations.list();
    const dependencies = await evaluateDependencies(this.dependencies);
    const byName = new Map(dependencies.map((dep) => [dep.name, dep.status]));
    // Backwards-compatible block from the persistence wave: same information,
    // rendered from the registry ('skipped' reads as the legacy 'disabled').
    const persistence: { database: PersistenceStatus; redis: PersistenceStatus } = {
      database: toPersistenceStatus(byName.get('database')),
      redis: toPersistenceStatus(byName.get('redis'))
    };
    const degraded =
      dependencies.some((dep) => dep.status === 'down') ||
      !statuses.every((s) => s.healthy);
    return {
      status: degraded ? 'degraded' : 'ok',
      integrations: statuses,
      persistence,
      dependencies
    };
  }
}
