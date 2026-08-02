import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@agric-platform/shared';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { UsersService } from '../../modules/users/users.service.js';
import { OidcService } from './oidc.service.js';
import { RolesGuard } from './roles.guard.js';

const ISSUER = 'https://keycloak.test/realms/agric-platform';
const AUDIENCE = 'agric-web';

let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

function makeGuard(required: UserRole[] | undefined): {
  activate: () => Promise<boolean>;
  request: { headers: Record<string, string>; user?: unknown };
  users: UsersService;
} {
  const reflector = new Reflector();
  // Avoid decorator plumbing: stub the metadata lookup per scenario.
  reflector.getAllAndOverride = () => required;
  const request: { headers: Record<string, string>; user?: unknown } = { headers: {} };
  const users = new UsersService(createInMemoryUserRepository());
  const guard = new RolesGuard(
    reflector,
    users,
    OidcService.forConfig({
      issuer: ISSUER,
      jwksUri: 'unused-in-tests',
      audience: AUDIENCE,
      jwksJson: JSON.stringify(jwks)
    })
  );
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;
  return { activate: () => guard.canActivate(context), request, users };
}

async function sign(claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expired?: boolean; subject?: string } = {}) {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.subject ?? 'user-admin')
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt();
  jwt = options.expired ? jwt.setExpirationTime(Math.floor(Date.now() / 1000) - 60) : jwt.setExpirationTime('5m');
  return jwt.sign(privateKey);
}

describe('RolesGuard (OIDC bearer + dev header)', () => {
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    jwks = { keys: [jwk] };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('passes routes without role requirements', async () => {
    const { activate } = makeGuard(undefined);
    await expect(activate()).resolves.toBe(true);
  });

  it('accepts a valid Keycloak bearer token with a matching realm role', async () => {
    const { activate, request } = makeGuard(['admin']);
    request.headers['authorization'] = `Bearer ${await sign({ realm_access: { roles: ['admin'] } })}`;
    await expect(activate()).resolves.toBe(true);
    expect((request.user as { id: string }).id).toBe('user-admin');
  });

  it('accepts client roles from resource_access for the configured audience', async () => {
    const { activate, request } = makeGuard(['admin']);
    request.headers['authorization'] = `Bearer ${await sign({
      resource_access: { [AUDIENCE]: { roles: ['admin'] } }
    })}`;
    await expect(activate()).resolves.toBe(true);
  });

  it('ignores client roles granted to OTHER clients when an audience is configured', async () => {
    // Attack: a user with an admin role on some other realm client presents
    // that token here. With an audience configured, roles are read only from
    // resource_access[audience] — never aggregated across clients.
    // Subject unknown to the user repository so the identity is synthesised
    // purely from token roles (a repo lookup would mask the extraction bug).
    const { activate, request } = makeGuard(['admin']);
    request.headers['authorization'] = `Bearer ${await sign(
      { resource_access: { 'other-client': { roles: ['admin'] } } },
      { subject: 'user-keycloak-only' }
    )}`;
    await expect(activate()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects tokens with the wrong issuer, audience or expiry', async () => {
    for (const token of [
      await sign({ realm_access: { roles: ['admin'] } }, { issuer: 'https://evil.test/realms/x' }),
      await sign({ realm_access: { roles: ['admin'] } }, { audience: 'other-client' }),
      await sign({ realm_access: { roles: ['admin'] } }, { expired: true })
    ]) {
      const { activate, request } = makeGuard(['admin']);
      request.headers['authorization'] = `Bearer ${token}`;
      await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('rejects tampered signatures', async () => {
    const { activate, request } = makeGuard(['admin']);
    const token = await sign({ realm_access: { roles: ['admin'] } });
    const [header] = token.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ realm_access: { roles: ['admin'] } })).toString('base64url')}.${'f'.repeat(64)}`;
    request.headers['authorization'] = `Bearer ${forged}`;
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never downgrades a bad bearer token to header auth', async () => {
    const { activate, request } = makeGuard(['admin']);
    request.headers['authorization'] = 'Bearer not-a-jwt';
    request.headers['x-user-id'] = 'user-admin';
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('honours the x-user-id header outside production', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_DEV_HEADER_AUTH;
    const { activate, request } = makeGuard(['admin']);
    request.headers['x-user-id'] = 'user-admin';
    await expect(activate()).resolves.toBe(true);
  });

  it('rejects the x-user-id header in production without the explicit opt-in', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_DEV_HEADER_AUTH;
    const { activate, request } = makeGuard(['admin']);
    request.headers['x-user-id'] = 'user-admin';
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);

    process.env.ALLOW_DEV_HEADER_AUTH = 'true';
    await expect(activate()).resolves.toBe(true);
  });

  it('returns 403 when roles do not match and 401 when anonymous', async () => {
    const farmer = makeGuard(['admin']);
    farmer.request.headers['x-user-id'] = 'user-farmer-2';
    await expect(farmer.activate()).rejects.toBeInstanceOf(ForbiddenException);

    const anon = makeGuard(['admin']);
    await expect(anon.activate()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a suspended user presenting a still-valid bearer token', async () => {
    const { activate, request, users } = makeGuard(['admin']);
    request.headers['authorization'] = `Bearer ${await sign({ realm_access: { roles: ['admin'] } })}`;
    await users.setStatus('user-admin', 'suspended');
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a suspended user presenting the development header', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_DEV_HEADER_AUTH;
    const { activate, request, users } = makeGuard(['admin']);
    request.headers['x-user-id'] = 'user-admin';
    await users.setStatus('user-admin', 'suspended');
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('restores access when the suspension is lifted', async () => {
    const { activate, request, users } = makeGuard(['admin']);
    request.headers['authorization'] = `Bearer ${await sign({ realm_access: { roles: ['admin'] } })}`;
    await users.setStatus('user-admin', 'suspended');
    await expect(activate()).rejects.toBeInstanceOf(UnauthorizedException);
    await users.setStatus('user-admin', 'active');
    await expect(activate()).resolves.toBe(true);
  });
});
