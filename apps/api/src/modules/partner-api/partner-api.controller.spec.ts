import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { PartnerApiController } from './partner-api.controller.js';
import type { PartnerApiService } from './partner-api.service.js';
import { PARTNER_SCOPES_KEY } from './partner-scopes.decorator.js';

/**
 * Member-profile route identity plumbing (Stage 27, WP-G4 — V3 middleware
 * audit). The guard itself (token/API-key verification, scopes, rate
 * limiting) is covered by partner-auth specs; here we pin that the route
 * requires a partner-bound credential and delegates with the bound
 * partnerId + clientId so the service can enforce member binding and audit
 * attribution.
 */
function makeController() {
  const service = {
    consentedMemberProfile: vi.fn().mockResolvedValue({ user: { id: 'user-a' } })
  } as unknown as PartnerApiService;
  return { controller: new PartnerApiController(service), service };
}

const request = (partner: Record<string, unknown>) =>
  ({ headers: {}, partner }) as unknown as Request;

describe('PartnerApiController member profile route (WP-G4)', () => {
  it('declares the profile:read scope', () => {
    const scopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      PartnerApiController.prototype.memberProfile
    );
    expect(scopes).toEqual(['profile:read']);
  });

  it('refuses credentials not bound to a partner organisation (403, fail closed)', async () => {
    const { controller, service } = makeController();
    // Developer API keys and pre-Stage-24 clients carry no partnerId claim.
    await expect(
      controller.memberProfile(
        'user-a',
        request({ clientId: 'apikey:user-dev', scopes: ['profile:read'], sandbox: false })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.consentedMemberProfile).not.toHaveBeenCalled();
  });

  it('delegates with the bound partnerId and clientId from the token', async () => {
    const { controller, service } = makeController();
    const result = await controller.memberProfile(
      'user-a',
      request({
        clientId: 'pc_lender',
        scopes: ['profile:read'],
        sandbox: false,
        partnerId: 'partner-1'
      })
    );
    expect(service.consentedMemberProfile).toHaveBeenCalledWith(
      'user-a',
      'partner-1',
      'pc_lender'
    );
    expect(result.data).toMatchObject({ user: { id: 'user-a' } });
  });
});
