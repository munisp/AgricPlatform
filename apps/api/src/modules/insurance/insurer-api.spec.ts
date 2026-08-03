import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { DeveloperApiKey } from '../../database/repositories/partner-api.repository.js';
import { PartnerAuthGuard } from '../partner-api/partner-auth.guard.js';
import type { PartnerAuthService } from '../partner-api/partner-auth.service.js';
import type { PartnerRateService } from '../partner-api/partner-rate.service.js';
import { PARTNER_SCOPES_KEY } from '../partner-api/partner-scopes.decorator.js';
import { InsurerApiController } from './insurer-api.controller.js';

/**
 * Insurer read API scoping (wave-insurance): both routes declare the
 * `insurance:read` scope and the partner guard enforces it for developer
 * API keys and OAuth tokens alike.
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
    getClass: () => InsurerApiController,
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

describe('insurer read API — insurance:read scoping', () => {
  it('declares the insurance:read scope on both insurer routes', () => {
    const reflector = new Reflector();
    for (const handler of [
      InsurerApiController.prototype.portfolio,
      InsurerApiController.prototype.triggerEvents
    ]) {
      expect(reflector.get(PARTNER_SCOPES_KEY, handler)).toEqual(['insurance:read']);
    }
  });

  it('admits a developer API key carrying insurance:read', async () => {
    const guard = makeGuard(apiKey(['insurance:read']));
    const context = contextFor(InsurerApiController.prototype.portfolio, {
      'x-api-key': 'agk_test_secret'
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('denies a developer API key without the insurance:read scope (403)', async () => {
    const guard = makeGuard(apiKey(['credit:read']));
    const context = contextFor(InsurerApiController.prototype.portfolio, {
      'x-api-key': 'agk_test_secret'
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies requests with no partner credentials (401)', async () => {
    const guard = makeGuard(undefined);
    const context = contextFor(InsurerApiController.prototype.triggerEvents, {});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies invalid or revoked API keys (401)', async () => {
    const guard = makeGuard(undefined);
    const context = contextFor(InsurerApiController.prototype.triggerEvents, {
      'x-api-key': 'agk_revoked'
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
