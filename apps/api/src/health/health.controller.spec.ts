import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { UserRole } from '@agric-platform/shared';
import { ROLES_KEY } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { OidcService } from '../common/auth/oidc.service.js';
import { createInMemoryUserRepository } from '../database/repositories/user.repository.js';
import { UsersService } from '../modules/users/users.service.js';
import { HealthController } from './health.controller.js';

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
