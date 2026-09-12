import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { PartnerApiController } from './partner-api.controller.js';
import type { PartnerApiService } from './partner-api.service.js';
import { PARTNER_SCOPES_KEY } from './partner-scopes.decorator.js';

/**
 * Partner write-route identity plumbing (Stage 27, WP-G22 — partner
 * write-path tenant binding). The guard itself (token/API-key verification,
 * scopes, rate limiting) is covered by partner-auth specs; here we pin that
 * the write routes resolve the effective tenant from the TOKEN's bound
 * partnerId (never caller-supplied slugs) and delegate with the bound
 * partnerId + clientId so the service can enforce member/programme binding
 * and audit attribution (actor = partner client, subject = user).
 *
 * Kept in a separate spec file from PR #62's partner-api.controller.spec.ts
 * (WP-G4) to avoid an add/add conflict while both are in flight.
 */
function makeController() {
  const service = {
    recordDisbursement: vi.fn().mockResolvedValue({ id: 'disb-1' }),
    recordEnrolment: vi.fn().mockResolvedValue({ id: 'penrol-1' }),
    recordFarmDataPush: vi.fn().mockResolvedValue({ id: 'farmdata-1', accepted: true })
  } as unknown as PartnerApiService;
  return { controller: new PartnerApiController(service), service };
}

const request = (partner: Record<string, unknown>) =>
  ({ headers: {}, partner }) as unknown as Request;

const boundIdentity = {
  clientId: 'pc_lender',
  scopes: ['disbursements:write', 'enrolments:write', 'farm_data:write'],
  sandbox: false,
  partnerId: 'partner-1'
};

describe('PartnerApiController write-path binding (WP-G22)', () => {
  it('declares the write scopes on all three routes', () => {
    expect(
      Reflect.getMetadata(PARTNER_SCOPES_KEY, PartnerApiController.prototype.recordDisbursement)
    ).toEqual(['disbursements:write']);
    expect(
      Reflect.getMetadata(PARTNER_SCOPES_KEY, PartnerApiController.prototype.recordEnrolment)
    ).toEqual(['enrolments:write']);
    expect(
      Reflect.getMetadata(PARTNER_SCOPES_KEY, PartnerApiController.prototype.farmDataPush)
    ).toEqual(['farm_data:write']);
  });

  it('disbursements: delegates with the bound partnerId and clientId', async () => {
    const { controller, service } = makeController();
    await controller.recordDisbursement(
      { userId: 'user-a', amountNgn: 50_000, programmeId: 'opp-1' },
      request(boundIdentity)
    );
    expect(service.recordDisbursement).toHaveBeenCalledWith(
      'partner-1',
      { userId: 'user-a', amountNgn: 50_000, programmeId: 'opp-1' },
      'pc_lender'
    );
  });

  it('disbursements: 400 on a caller-supplied partnerId that contradicts the token', async () => {
    const { controller, service } = makeController();
    await expect(
      controller.recordDisbursement(
        { partnerId: 'partner-2', userId: 'user-a', amountNgn: 10 },
        request(boundIdentity)
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.recordDisbursement).not.toHaveBeenCalled();
  });

  it('enrolments: delegates with the bound partnerId and clientId', async () => {
    const { controller, service } = makeController();
    await controller.recordEnrolment(
      { userId: 'user-a', programmeId: 'opp-1' },
      request(boundIdentity)
    );
    expect(service.recordEnrolment).toHaveBeenCalledWith(
      'partner-1',
      { userId: 'user-a', programmeId: 'opp-1' },
      'pc_lender'
    );
  });

  it('farm-data: refuses credentials not bound to a partner organisation (403, fail closed)', async () => {
    const { controller, service } = makeController();
    // Developer API keys and pre-Stage-24 clients carry no partnerId claim.
    await expect(
      controller.farmDataPush(
        { userId: 'user-a', assets: [] },
        request({ clientId: 'apikey:user-dev', scopes: ['farm_data:write'], sandbox: false })
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.recordFarmDataPush).not.toHaveBeenCalled();
  });

  it('farm-data: delegates the token partnerId, subject userId and clientId', async () => {
    const { controller, service } = makeController();
    const result = await controller.farmDataPush(
      { userId: 'user-a', assets: [{ type: 'asset--land' }] },
      request(boundIdentity)
    );
    expect(service.recordFarmDataPush).toHaveBeenCalledWith(
      'partner-1',
      'user-a',
      expect.objectContaining({ userId: 'user-a' }),
      'pc_lender'
    );
    expect(result.data).toMatchObject({ id: 'farmdata-1', accepted: true });
  });
});
