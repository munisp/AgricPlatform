import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@agric-platform/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OidcIdentity } from '../auth/oidc.service.js';
import type { OidcService } from '../auth/oidc.service.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { UsersService } from '../../modules/users/users.service.js';
import { MetricsAccessGuard, metricsTokenMatches } from './metrics-access.guard.js';

const ADMIN: User = {
  id: 'user-admin',
  phone: '+2348010000000',
  fullName: 'Admin',
  roles: ['admin'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastActiveAt: '2025-01-01T00:00:00.000Z'
};

const FARMER: User = { ...ADMIN, id: 'user-aisha', roles: ['farmer'] };

function makeContext(headers: Record<string, string>): ExecutionContext {
  const handler = (): void => undefined;
  // Mirror the @Roles('admin') metadata on the metrics route.
  Reflect.defineMetadata(ROLES_KEY, ['admin'], handler);
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    getHandler: () => handler,
    getClass: () => class {}
  } as unknown as ExecutionContext;
}

function makeGuard(options: {
  users?: Record<string, User>;
  verify?: (token: string) => Promise<OidcIdentity>;
}): MetricsAccessGuard {
  const users = {
    findById: async (id: string) => options.users?.[id],
    statusFor: async () => 'active'
  } as unknown as UsersService;
  const oidc = {
    verify:
      options.verify ??
      (async (): Promise<OidcIdentity> => {
        throw new Error('signature verification failed');
      })
  } as unknown as OidcService;
  return new MetricsAccessGuard(new Reflector(), users, oidc);
}

describe('metricsTokenMatches', () => {
  it('accepts identical tokens', () => {
    expect(metricsTokenMatches('scrape-secret', 'scrape-secret')).toBe(true);
  });

  it('rejects different tokens, including length mismatches', () => {
    expect(metricsTokenMatches('scrape-secret', 'other-secret')).toBe(false);
    expect(metricsTokenMatches('short', 'much-longer-token-value')).toBe(false);
  });
});

describe('MetricsAccessGuard', () => {
  const env = { ...process.env };

  beforeEach(() => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('allows a matching METRICS_TOKEN bearer', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret';
    const guard = makeGuard({});
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer scrape-secret' }))
    ).resolves.toBe(true);
  });

  it('rejects a non-matching bearer (never downgrades to anonymous)', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret';
    const guard = makeGuard({});
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer wrong' }))
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows an admin OIDC bearer even when METRICS_TOKEN is also configured', async () => {
    process.env.METRICS_TOKEN = 'scrape-secret';
    const guard = makeGuard({
      verify: async (token) => {
        if (token !== 'admin-jwt') {
          throw new Error('bad token');
        }
        return { subject: 'keycloak-admin', roles: ['admin'], claims: {} };
      }
    });
    await expect(
      guard.canActivate(makeContext({ authorization: 'Bearer admin-jwt' }))
    ).resolves.toBe(true);
  });

  it('allows an admin via the development identity header outside production', async () => {
    const guard = makeGuard({ users: { 'user-admin': ADMIN } });
    await expect(guard.canActivate(makeContext({ 'x-user-id': 'user-admin' }))).resolves.toBe(
      true
    );
  });

  it('rejects a non-admin identity with 403', async () => {
    const guard = makeGuard({ users: { 'user-aisha': FARMER } });
    await expect(guard.canActivate(makeContext({ 'x-user-id': 'user-aisha' }))).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('fails closed for anonymous scrapes in production', async () => {
    process.env.NODE_ENV = 'production';
    const guard = makeGuard({});
    await expect(guard.canActivate(makeContext({}))).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('fails closed in production even when no METRICS_TOKEN is configured', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.METRICS_TOKEN;
    const guard = makeGuard({});
    await expect(guard.canActivate(makeContext({}))).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('allows anonymous scrapes outside production (local Prometheus parity)', async () => {
    const guard = makeGuard({});
    await expect(guard.canActivate(makeContext({}))).resolves.toBe(true);
  });
});
