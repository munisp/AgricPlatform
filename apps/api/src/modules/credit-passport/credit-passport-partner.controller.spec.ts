import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { PartnerAuthGuard } from '../partner-api/partner-auth.guard.js';
import { PARTNER_SCOPES_KEY } from '../partner-api/partner-scopes.decorator.js';
import { CreditPassportPartnerController } from './credit-passport-partner.controller.js';
import { CREDIT_PASSPORT_READ_SCOPE } from './credit-passport.service.js';

/**
 * Partner-API scope guard coverage for the credit passport read route
 * (Stage 27, Innovation 7). Exercises the REAL PartnerAuthGuard against the
 * route's declared scope metadata: a credential lacking
 * `credit-passport:read` is rejected with 403; a scoped credential passes
 * and the identity is attached to the request.
 */
describe('CreditPassportPartnerController scope guard', () => {
  const requiredScopes = Reflect.getMetadata(
    PARTNER_SCOPES_KEY,
    CreditPassportPartnerController.prototype.readForPartner
  ) as string[] | undefined;

  const guardWith = (apiKeyScopes: string[]) => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(requiredScopes)
    };
    const auth = {
      verifyApiKey: vi.fn().mockResolvedValue({
        id: 'key-1',
        ownerUserId: 'dev-1',
        scopes: apiKeyScopes,
        sandbox: true
      })
    };
    const rate = { consume: vi.fn().mockResolvedValue(999) };
    const clients = { findOne: vi.fn().mockResolvedValue(undefined) };
    const guard = new PartnerAuthGuard(
      reflector as unknown as Reflector,
      auth as never,
      rate as never,
      clients as never
    );
    const request: { headers: Record<string, string>; partner?: unknown } = {
      headers: { 'x-api-key': 'ak_test_key' }
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => CreditPassportPartnerController.prototype.readForPartner,
      getClass: () => CreditPassportPartnerController
    } as unknown as ExecutionContext;
    return { guard, context, request, rate };
  };

  it('declares the credit-passport:read scope on the partner route', () => {
    expect(requiredScopes).toEqual([CREDIT_PASSPORT_READ_SCOPE]);
    expect(CREDIT_PASSPORT_READ_SCOPE).toBe('credit-passport:read');
  });

  it('rejects a partner credential missing credit-passport:read (403)', async () => {
    const { guard, context } = guardWith(['profile:read', 'impact:read']);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(context)).rejects.toThrow('credit-passport:read');
  });

  it('admits a scoped credential and attaches the partner identity', async () => {
    const { guard, context, request } = guardWith([CREDIT_PASSPORT_READ_SCOPE]);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.partner).toMatchObject({
      clientId: 'apikey:dev-1',
      scopes: [CREDIT_PASSPORT_READ_SCOPE]
    });
  });
});
