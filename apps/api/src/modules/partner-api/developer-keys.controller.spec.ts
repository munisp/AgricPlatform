import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { User, UserRole } from '@agric-platform/shared';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { RolesGuard } from '../../common/auth/roles.guard.js';
import { OidcService } from '../../common/auth/oidc.service.js';
import { UsersService } from '../users/users.service.js';
import { DeveloperKeysController } from './developer-keys.controller.js';
import { PARTNER_API_SCOPES } from './partner-scopes.decorator.js';
import type { PartnerAuthService } from './partner-auth.service.js';

/**
 * OB-08: developer API key issuance is privileged. The controller is locked
 * to admin/partner at the RolesGuard metadata level, and requested scopes
 * are whitelisted against the scopes actually consumed by @PartnerScopes
 * routes. These tests pin both halves: role enforcement (farmer 403, admin
 * 200) through the real guard, and scope validation (unknown scope 400)
 * through the controller method.
 */

function makeUser(id: string, roles: UserRole[]): User {
  const now = new Date().toISOString();
  return {
    id,
    phone: '+2348000000000',
    fullName: 'Key Owner',
    roles,
    preferredLanguage: 'en',
    kycTier: 'tier_0',
    isVerified: true,
    createdAt: now,
    lastActiveAt: now
  };
}

function stubAuth(): PartnerAuthService {
  return {
    issueApiKey: vi.fn(async () => ({
      apiKey: {
        id: 'key-1',
        prefix: 'ak_test',
        scopes: ['profile:read'],
        sandbox: true,
        createdAt: new Date().toISOString()
      },
      plaintext: 'ak_plaintext_once'
    }))
  } as unknown as PartnerAuthService;
}

describe('DeveloperKeysController scope whitelist (OB-08)', () => {
  it('issues a key for known scopes', async () => {
    const auth = stubAuth();
    const controller = new DeveloperKeysController(auth);
    const result = await controller.issue(makeUser('user-admin', ['admin']), {
      scopes: ['profile:read', 'programmes:read']
    });
    expect(result.data.key).toBe('ak_plaintext_once');
    expect(auth.issueApiKey).toHaveBeenCalledWith({
      ownerUserId: 'user-admin',
      scopes: ['profile:read', 'programmes:read']
    });
  });

  it('rejects unknown scope strings with 400 before any key is minted', async () => {
    const auth = stubAuth();
    const controller = new DeveloperKeysController(auth);
    await expect(
      controller.issue(makeUser('user-admin', ['admin']), {
        scopes: ['profile:read', 'admin:everything']
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(auth.issueApiKey).not.toHaveBeenCalled();
  });

  it('whitelist covers every scope declared on partner routes', () => {
    // Guard against drift: spot-check the scopes known to be consumed
    // downstream (portfolio scorecards, traceability, credit passport).
    for (const scope of [
      'portfolio:read',
      'traceability:write',
      'traceability:dds',
      'credit-passport:read',
      'webhooks:manage',
      'insurance:read'
    ]) {
      expect(PARTNER_API_SCOPES).toContain(scope);
    }
  });
});

describe('DeveloperKeysController role enforcement (OB-08)', () => {
  const reflector = new Reflector();

  it('declares admin/partner-only at the class level', () => {
    expect(reflector.get<string[]>(ROLES_KEY, DeveloperKeysController)).toEqual([
      'admin',
      'partner'
    ]);
  });

  /**
   * Runs the REAL RolesGuard against the controller's own metadata with the
   * development identity header (dev-header auth is allowed outside
   * production; vitest never sets NODE_ENV=production).
   */
  async function activateWithRole(roles: UserRole[]): Promise<boolean> {
    const users = new UsersService(createInMemoryUserRepository());
    const user = await users.create({
      phone: '+2348000000001',
      fullName: 'Key Owner',
      roles,
      preferredLanguage: 'en'
    });
    const guard = new RolesGuard(
      reflector,
      users,
      OidcService.forConfig({
        issuer: 'https://keycloak.test/realms/agric-platform',
        jwksUri: 'unused-in-tests',
        audience: 'agric-web',
        jwksJson: JSON.stringify({ keys: [] })
      })
    );
    const request = { headers: { 'x-user-id': user.id } };
    const context = {
      // Method carries no override; the class-level @Roles decides.
      getHandler: () => DeveloperKeysController.prototype.issue,
      getClass: () => DeveloperKeysController,
      switchToHttp: () => ({ getRequest: () => request })
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  }

  it('allows an admin through (200 path)', async () => {
    await expect(activateWithRole(['admin'])).resolves.toBe(true);
  });

  it('allows a partner through (200 path)', async () => {
    await expect(activateWithRole(['partner'])).resolves.toBe(true);
  });

  it('rejects a farmer with 403', async () => {
    await expect(activateWithRole(['farmer'])).rejects.toBeInstanceOf(ForbiddenException);
  });
});
