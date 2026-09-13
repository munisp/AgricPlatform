/**
 * Lender Lens partner controller tests (Stage 27, innovation #20): tenant
 * binding (fail closed for unbound credentials), scope decorator wiring, and
 * delegation to the scorecard/export services. The PartnerAuthGuard scope
 * check itself is covered by partner-auth.service/guard specs; here we pin
 * that the routes DECLARE the portfolio:read scope.
 */
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import type { LenderScorecardExportService } from '../analytics/lender-scorecard-export.service.js';
import type { LenderScorecardService } from '../analytics/lender-scorecard.service.js';
import { PARTNER_SCOPES_KEY } from './partner-scopes.decorator.js';
import { PortfolioScorecardController } from './portfolio-scorecard.controller.js';
import type { PartnerRequestIdentity } from './partner-auth.guard.js';

const BOUND: PartnerRequestIdentity = {
  clientId: 'client-1',
  scopes: ['portfolio:read'],
  sandbox: false,
  partnerId: 'lender-a'
};

function requestWith(identity: PartnerRequestIdentity | undefined): Request {
  return { partner: identity } as unknown as Request;
}

function controller() {
  const envelopes: unknown[] = [];
  const scorecards = {
    scorecard: async (lender: string, period?: string, version?: string) => {
      const envelope = { payload: { lenderPartnerId: lender, period, version }, stale: true };
      envelopes.push(envelope);
      return envelope;
    }
  };
  const exports = {
    export: async (lender: string, period?: string, version?: string) => ({
      lenderPartnerId: lender,
      period,
      version,
      url: 'http://localhost:9000/signed',
      manifestUrl: 'http://localhost:9000/signed-manifest'
    })
  };
  const ctl = new PortfolioScorecardController(
    scorecards as unknown as LenderScorecardService,
    exports as unknown as LenderScorecardExportService
  );
  return { ctl, envelopes };
}

describe('PortfolioScorecardController', () => {
  it('declares the additive portfolio:read scope on both routes', () => {
    const scorecardScopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      PortfolioScorecardController.prototype.scorecard
    );
    const exportScopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      PortfolioScorecardController.prototype.exportScorecard
    );
    expect(scorecardScopes).toEqual(['portfolio:read']);
    expect(exportScopes).toEqual(['portfolio:read']);
  });

  it('serves the scorecard for the token-bound lender tenant', async () => {
    const { ctl } = controller();
    const response = await ctl.scorecard('2026-08', undefined, requestWith(BOUND));
    expect(response.data.payload.lenderPartnerId).toBe('lender-a');
    expect(response.data.payload.period).toBe('2026-08');
  });

  it('fails closed for unbound credentials (developer keys)', async () => {
    const { ctl } = controller();
    const unbound: PartnerRequestIdentity = {
      clientId: 'apikey:user-1',
      scopes: ['portfolio:read'],
      sandbox: false
    };
    await expect(ctl.scorecard('2026-08', undefined, requestWith(unbound))).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(
      ctl.exportScorecard('2026-08', undefined, requestWith(unbound))
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates export to the storage-gated export service', async () => {
    const { ctl } = controller();
    const response = await ctl.exportScorecard('2026-08', '1.0.0', requestWith(BOUND));
    expect(response.data.url).toContain('http://localhost:9000/');
  });
});
