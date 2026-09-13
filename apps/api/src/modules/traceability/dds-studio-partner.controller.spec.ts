import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { DeveloperApiKey } from '../../database/repositories/partner-api.repository.js';
import { PartnerAuthGuard } from '../partner-api/partner-auth.guard.js';
import type { PartnerAuthService } from '../partner-api/partner-auth.service.js';
import type { PartnerRateService } from '../partner-api/partner-rate.service.js';
import { PARTNER_SCOPES_KEY } from '../partner-api/partner-scopes.decorator.js';
import { DdsStudioPartnerController } from './dds-studio-partner.controller.js';
import type { DdsStudioService } from './dds-studio.service.js';

/**
 * DDS Studio exporter surface (stage 27 innovation 17): every route declares
 * the ADDITIVE `traceability:dds` scope and the partner guard enforces it for
 * developer API keys and OAuth tokens alike. Existing traceability:read /
 * traceability:write scopes are untouched — a client carrying only those is
 * denied here (403).
 */

function apiKey(scopes: string[]): DeveloperApiKey {
  return {
    id: 'key-1',
    ownerUserId: 'partner-user-1',
    keyHash: 'x',
    keySalt: 'y',
    prefix: 'agk_test',
    scopes,
    sandbox: false,
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function contextFor(handler: object, headers: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DdsStudioPartnerController,
    switchToHttp: () => ({ getRequest: () => ({ headers }) })
  } as unknown as ExecutionContext;
}

function makeGuard(key: DeveloperApiKey | undefined) {
  const auth = {
    verifyApiKey: () => Promise.resolve(key),
    verifyToken: () => Promise.reject(new Error('not used'))
  } as unknown as PartnerAuthService;
  const rate = { consume: () => Promise.resolve(999) } as unknown as PartnerRateService;
  const clients = { findOne: () => Promise.resolve(undefined) };
  return new PartnerAuthGuard(new Reflector(), auth, rate, clients as never);
}

const DDS_ROUTES = [
  DdsStudioPartnerController.prototype.createDraft,
  DdsStudioPartnerController.prototype.getPackage,
  DdsStudioPartnerController.prototype.validate,
  DdsStudioPartnerController.prototype.export
];

describe('DDS Studio partner API — traceability:dds scoping', () => {
  it('declares the traceability:dds scope on all four routes', () => {
    const reflector = new Reflector();
    for (const handler of DDS_ROUTES) {
      expect(reflector.get(PARTNER_SCOPES_KEY, handler)).toEqual(['traceability:dds']);
    }
  });

  it('admits a developer API key carrying traceability:dds', async () => {
    const guard = makeGuard(apiKey(['traceability:dds']));
    const context = contextFor(DdsStudioPartnerController.prototype.validate, {
      'x-api-key': 'agk_test_secret'
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies a key holding only the legacy traceability scopes (403)', async () => {
    const guard = makeGuard(apiKey(['traceability:read', 'traceability:write']));
    const context = contextFor(DdsStudioPartnerController.prototype.export, {
      'x-api-key': 'agk_test_secret'
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies requests with no partner credentials (401)', async () => {
    const guard = makeGuard(undefined);
    const context = contextFor(DdsStudioPartnerController.prototype.createDraft, {});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('DDS Studio partner API — identity plumbing', () => {
  function makeController() {
    const service = {
      createDraftForPartner: vi.fn().mockResolvedValue({ id: 'dds-1', status: 'draft' }),
      getPackageForPartner: vi.fn().mockResolvedValue({ id: 'dds-1' }),
      validateForPartner: vi.fn().mockResolvedValue({ package: { id: 'dds-1' }, validation: { result: 'pass' } }),
      exportForPartner: vi.fn().mockResolvedValue({ packageId: 'dds-1', packageHash: 'ab'.repeat(32) })
    } as unknown as DdsStudioService;
    return { controller: new DdsStudioPartnerController(service), service };
  }

  const request = (clientId: string) => ({
    headers: {},
    partner: { clientId, scopes: ['traceability:dds'], sandbox: false }
  });

  it('routes every operation under the authenticated partner client id', async () => {
    const { controller, service } = makeController();
    await controller.createDraft('tsh-1', request('acme-export'));
    expect(service.createDraftForPartner).toHaveBeenCalledWith('acme-export', 'tsh-1');
    await controller.validate('dds-1', request('acme-export'));
    expect(service.validateForPartner).toHaveBeenCalledWith('acme-export', 'dds-1');
    await controller.export('dds-1', request('acme-export'));
    expect(service.exportForPartner).toHaveBeenCalledWith('acme-export', 'dds-1');
    await controller.getPackage('dds-1', request('acme-export'));
    expect(service.getPackageForPartner).toHaveBeenCalledWith('acme-export', 'dds-1');
  });
});
