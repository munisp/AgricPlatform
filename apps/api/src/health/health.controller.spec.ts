import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@agric-platform/shared';
import { ROLES_KEY } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { OidcService } from '../common/auth/oidc.service.js';
import { TelemetryService } from '../common/telemetry/telemetry.service.js';
import { createInMemoryUserRepository } from '../database/repositories/user.repository.js';
import type { IntegrationsService } from '../modules/integrations/integrations.service.js';
import { UsersService } from '../modules/users/users.service.js';
import type { DependencyIndicator } from './dependency-indicator.js';
import { HealthController } from './health.controller.js';
import type { InfraDriverProbe, StatusedDriver } from './infra-driver-registry.js';
import type { ModuleHealthService } from './module-health.service.js';

/**
 * G14: /health/modules exposes the internal module/dependency matrix and
 * must be admin-only; the probe endpoints stay public. Verified through the
 * real RolesGuard driven by the controller's own decorator metadata.
 */
function activate(
  handler: (...args: never[]) => unknown,
  headers: Record<string, string>
): Promise<boolean> {
  const reflector = new Reflector();
  const guard = new RolesGuard(
    reflector,
    new UsersService(createInMemoryUserRepository()),
    OidcService.forConfig(null)
  );
  const context = {
    getHandler: () => handler,
    getClass: () => HealthController,
    switchToHttp: () => ({ getRequest: () => ({ headers }) })
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

describe('HealthController access control (G14)', () => {
  it('marks /health/modules as admin-only', () => {
    const required = Reflect.getMetadata(ROLES_KEY, HealthController.prototype.modules) as
      | UserRole[]
      | undefined;
    expect(required).toEqual(['admin']);
  });

  it('keeps the probe endpoints free of role metadata (public)', () => {
    for (const probe of ['health', 'live', 'ready'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, HealthController.prototype[probe])).toBeUndefined();
    }
  });

  it('guard allows anonymous probes but rejects anonymous module matrix reads', async () => {
    await expect(activate(HealthController.prototype.ready, {})).resolves.toBe(true);
    await expect(activate(HealthController.prototype.modules, {})).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('guard admits an admin to the module matrix (development header)', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      await expect(
        activate(HealthController.prototype.modules, { 'x-user-id': 'user-admin' })
      ).resolves.toBe(true);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

/**
 * WP-G10: /health/ready degraded-not-down aggregation. Optional infra
 * drivers (event-bus, orchestrator, authz) degrade the response payload
 * without failing it; only REQUIRED dependencies (postgres) fail the probe
 * with 503; stub/unconfigured drivers report 'disabled'.
 *
 * V-77: redis is no longer REQUIRED — the degraded-tier design keeps the
 * API alive (throttle cache fail-open, idempotency/OTP stores fail-closed)
 * and surfaces the outage as a tier-aware degraded[] entry instead.
 */
function readyController(options: {
  dependencies?: DependencyIndicator[];
  probes?: InfraDriverProbe[];
  integrationsHealthy?: boolean;
}): HealthController {
  const integrations = {
    list: () => [
      {
        provider: 'termii',
        capability: 'sms',
        driver: 'stub' as const,
        configured: false,
        healthy: options.integrationsHealthy ?? true,
        notes: 'stub driver'
      }
    ]
  };
  return new HealthController(
    integrations as unknown as IntegrationsService,
    {} as ModuleHealthService,
    new TelemetryService(),
    options.dependencies ?? [],
    null, // pgPool (WP-G7 ctor param; the WP-G10 aggregation tests do not exercise it)
    options.probes ?? []
  );
}

function fakeDriver(
  name: string,
  status: Record<string, unknown>
): StatusedDriver {
  return {
    name,
    status: () => Promise.resolve(status as never)
  };
}

function failingPg(): DependencyIndicator {
  return {
    name: 'database',
    configured: () => true,
    check: () => Promise.reject(new Error('connection refused'))
  };
}

describe('HealthController /health/ready aggregation (WP-G10)', () => {
  it('returns degraded-not-down (resolves) with a degraded optional driver listed', async () => {
    const controller = readyController({
      probes: [
        {
          port: 'event-bus',
          driver: fakeDriver('kafka', {
            configured: true,
            healthy: false,
            circuitBreaker: 'open',
            lastErrorClass: 'network',
            lastSuccessAt: null,
            detail: 'Kafka producer connected but circuit open after 3 consecutive failures.'
          })
        }
      ]
    });
    const report = await controller.ready();
    expect(report.status).toBe('degraded');
    expect(report.drivers).toHaveLength(1);
    expect(report.drivers[0]).toMatchObject({
      port: 'event-bus',
      driver: 'kafka',
      enabled: true,
      state: 'degraded',
      circuitBreaker: 'open',
      lastErrorClass: 'network'
    });
    expect(report.degraded).toHaveLength(1);
    expect(report.degraded[0].name).toBe('event-bus');
    expect(report.degraded[0].reason).toContain('circuit open');
  });

  it('fails with 503 when a REQUIRED dependency (postgres) is down', async () => {
    const controller = readyController({ dependencies: [failingPg()] });
    const failure = await controller.ready().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
    expect((failure as ServiceUnavailableException).message).toContain('database');
  });

  it('V-77: redis down is degraded-not-down, with a cache-vs-store tier reason', async () => {
    const failingRedis: DependencyIndicator = {
      name: 'redis',
      configured: () => true,
      check: () => Promise.reject(new Error('connection refused'))
    };
    const controller = readyController({ dependencies: [failingRedis] });
    // Must RESOLVE (200-degraded), not 503 — pods must not all evict on a
    // redis blip (S-40).
    const report = await controller.ready();
    expect(report.status).toBe('degraded');
    expect(report.persistence.redis).toBe('down');
    const redisDegradation = report.degraded.find((entry) => entry.name === 'redis');
    expect(redisDegradation).toBeDefined();
    // The reason distinguishes the two tiers: cache (fail-open) vs store
    // (fail-closed 503).
    expect(redisDegradation?.reason).toContain('fail-open');
    expect(redisDegradation?.reason).toContain('fail-closed');
  });

  it('does not fail when postgres is unconfigured (skipped → disabled)', async () => {
    const controller = readyController({
      dependencies: [
        { name: 'database', configured: () => false, check: () => Promise.reject(new Error('never')) },
        { name: 'redis', configured: () => false, check: () => Promise.reject(new Error('never')) }
      ]
    });
    const report = await controller.ready();
    expect(report.status).toBe('ok');
    expect(report.persistence).toEqual({ database: 'disabled', redis: 'disabled' });
    expect(report.degraded).toEqual([]);
  });

  it('reports a stub (disabled) driver as disabled, not down or degraded', async () => {
    const controller = readyController({
      probes: [
        {
          port: 'orchestrator',
          driver: fakeDriver('stub', {
            configured: true,
            healthy: true,
            detail: 'Stub driver: direct in-process invocation.'
          })
        }
      ]
    });
    const report = await controller.ready();
    expect(report.status).toBe('ok');
    expect(report.drivers[0]).toMatchObject({
      port: 'orchestrator',
      driver: 'stub',
      enabled: false,
      state: 'disabled'
    });
    expect(report.degraded).toEqual([]);
  });

  it('treats a lazy (never-connected, no failures) live driver as ok, not degraded', async () => {
    const controller = readyController({
      probes: [
        {
          port: 'orchestrator',
          driver: fakeDriver('temporal', {
            configured: true,
            healthy: false,
            circuitBreaker: 'closed',
            lastErrorClass: null,
            lastSuccessAt: null,
            detail: 'Temporal driver selected; connects on first workflow start.'
          })
        }
      ]
    });
    const report = await controller.ready();
    expect(report.status).toBe('ok');
    expect(report.drivers[0].state).toBe('ok');
    expect(report.degraded).toEqual([]);
  });

  it('keeps the endpoint up when a driver status probe itself throws', async () => {
    const controller = readyController({
      probes: [
        {
          port: 'authz',
          driver: {
            name: 'permify',
            status: () => Promise.reject(new Error('status boom'))
          }
        }
      ]
    });
    const report = await controller.ready();
    expect(report.status).toBe('degraded');
    expect(report.drivers[0].state).toBe('degraded');
    expect(report.drivers[0].lastErrorClass).toBe('internal');
    expect(report.degraded.map((entry) => entry.name)).toContain('authz');
  });

  it('lists unhealthy integrations in degraded[] without failing', async () => {
    const controller = readyController({ integrationsHealthy: false });
    const report = await controller.ready();
    expect(report.status).toBe('degraded');
    expect(report.degraded.map((entry) => entry.name)).toContain('integration:termii');
  });
});

describe('HealthController.ready (WP-G7 pool stats, WP-G8 temporal readiness)', () => {
  function controller(overrides: {
    integrationsHealthy?: boolean;
    dependencies?: import('./dependency-indicator.js').DependencyIndicator[];
    pgPool?: unknown;
  }) {
    const integrations = {
      list: () => [{ name: 'sms', driver: 'stub', healthy: overrides.integrationsHealthy ?? true }]
    };
    const moduleHealth = { report: () => ({}) };
    return new HealthController(
      integrations as never,
      moduleHealth as never,
      new TelemetryService(),
      overrides.dependencies ?? [],
      (overrides.pgPool ?? null) as never
    );
  }

  it('reports pg pool occupancy (total/idle/waiting) when a pool is injected', async () => {
    const result = await controller({
      pgPool: { totalCount: 4, idleCount: 3, waitingCount: 1 }
    }).ready();
    expect(result.status).toBe('ok');
    expect(result.pgPool).toEqual({ total: 4, idle: 3, waiting: 1 });
  });

  it("reports pgPool 'disabled' in in-memory mode", async () => {
    const result = await controller({}).ready();
    expect(result.pgPool).toBe('disabled');
  });

  it('stays ok under the stub workflow driver (temporal-worker skipped)', async () => {
    const { TemporalWorkerIndicator } = await import('./temporal-worker.indicator.js');
    const result = await controller({
      dependencies: [new TemporalWorkerIndicator({})]
    }).ready();
    expect(result.status).toBe('ok');
    expect(result.dependencies).toEqual([
      { name: 'temporal-worker', status: 'skipped', latencyMs: 0 }
    ]);
  });

  it('degrades readiness when WORKFLOW_DRIVER=temporal and no worker polls the task queue', async () => {
    const { TemporalWorkerIndicator } = await import('./temporal-worker.indicator.js');
    const result = await controller({
      dependencies: [
        new TemporalWorkerIndicator(
          { WORKFLOW_DRIVER: 'temporal', TEMPORAL_ADDRESS: 'localhost:7233' },
          () => Promise.resolve(0)
        )
      ]
    }).ready();
    expect(result.status).toBe('degraded');
    expect(result.dependencies).toEqual([
      expect.objectContaining({ name: 'temporal-worker', status: 'down' })
    ]);
  });
});
