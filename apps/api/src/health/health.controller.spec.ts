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
