import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { createInMemoryPartnerMemberRepository } from '../../database/repositories/partner-member.repository.js';
import { TenantGuard } from './tenant.guard.js';

const PARTNER_USER: User = {
  id: 'user-partner',
  phone: '+2348010000001',
  fullName: 'Partner Rep',
  roles: ['partner'],
  preferredLanguage: 'en',
  kycTier: 'tier_3',
  isVerified: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastActiveAt: '2025-01-01T00:00:00.000Z'
};

const ADMIN: User = { ...PARTNER_USER, id: 'user-admin', roles: ['admin'] };
const FARMER: User = { ...PARTNER_USER, id: 'user-aisha', roles: ['farmer'] };

function makeGuard(): TenantGuard {
  // Seeded with user-partner ↔ 'agri-partner-foundation' (seed-data.ts).
  return new TenantGuard(createInMemoryPartnerMemberRepository());
}

function makeContext(options: {
  params?: Record<string, unknown>;
  user?: unknown;
  type?: string;
}): ExecutionContext {
  return {
    getType: () => options.type ?? 'http',
    switchToHttp: () => ({
      getRequest: () => ({ params: options.params ?? {}, user: options.user })
    })
  } as unknown as ExecutionContext;
}

describe('TenantGuard (GAP-M08 pipeline tenant enforcement)', () => {
  it('passes routes without a :partnerId path parameter untouched', async () => {
    await expect(
      makeGuard().canActivate(makeContext({ params: { id: 'x' }, user: FARMER }))
    ).resolves.toBe(true);
  });

  it('passes requests with no authenticated user (public/M2M routes bind the tenant themselves)', async () => {
    await expect(
      makeGuard().canActivate(makeContext({ params: { partnerId: 'agri-partner-foundation' } }))
    ).resolves.toBe(true);
  });

  it('passes admins regardless of membership (same rule as PartnerService.assertPartnerAccess)', async () => {
    await expect(
      makeGuard().canActivate(makeContext({ params: { partnerId: 'any-partner' }, user: ADMIN }))
    ).resolves.toBe(true);
  });

  it('admits a partner-role caller bound to the requested organisation', async () => {
    await expect(
      makeGuard().canActivate(
        makeContext({ params: { partnerId: 'agri-partner-foundation' }, user: PARTNER_USER })
      )
    ).resolves.toBe(true);
  });

  it('rejects a partner-role caller bound to a DIFFERENT organisation (cross-tenant, 403)', async () => {
    await expect(
      makeGuard().canActivate(
        makeContext({ params: { partnerId: 'victim-foundation' }, user: PARTNER_USER })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed for an authenticated caller with no membership row', async () => {
    await expect(
      makeGuard().canActivate(
        makeContext({ params: { partnerId: 'agri-partner-foundation' }, user: FARMER })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ignores non-HTTP contexts', async () => {
    await expect(
      makeGuard().canActivate(makeContext({ type: 'rpc', params: { partnerId: 'x' }, user: FARMER }))
    ).resolves.toBe(true);
  });
});
