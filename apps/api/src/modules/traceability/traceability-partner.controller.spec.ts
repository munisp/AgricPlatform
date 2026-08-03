import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PARTNER_SCOPES_KEY } from '../partner-api/partner-scopes.decorator.js';
import { TraceabilityPartnerController } from './traceability-partner.controller.js';
import type { TraceabilityService } from './traceability.service.js';

/**
 * Exporter surface scope declarations + identity plumbing (wave-eudr). The
 * guard itself (token/API-key verification, rate limiting, scope
 * enforcement) is covered by partner-api specs; here we pin that every
 * route declares the right scope metadata the guard enforces, and that the
 * resolved partner identity is what scopes record access.
 */
function makeController() {
  const service = {
    createShipmentForPartner: vi.fn().mockResolvedValue({ shipment: { id: 'tsh-1' }, lots: [] }),
    exportDdsForPartner: vi.fn().mockResolvedValue({ ddsReference: 'tsh-1' }),
    verifyShipmentChainForPartner: vi.fn().mockResolvedValue({ allValid: true })
  } as unknown as TraceabilityService;
  return { controller: new TraceabilityPartnerController(service), service };
}

const request = (clientId: string) => ({
  headers: {},
  partner: { clientId, scopes: ['traceability:read', 'traceability:write'], sandbox: false }
});

describe('TraceabilityPartnerController scope declarations', () => {
  it('shipment creation requires traceability:write', () => {
    const scopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      TraceabilityPartnerController.prototype.createShipment
    );
    expect(scopes).toEqual(['traceability:write']);
  });

  it('DDS fetch requires traceability:read', () => {
    const scopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      TraceabilityPartnerController.prototype.fetchDds
    );
    expect(scopes).toEqual(['traceability:read']);
  });

  it('DDS verify requires traceability:read', () => {
    const scopes = Reflect.getMetadata(
      PARTNER_SCOPES_KEY,
      TraceabilityPartnerController.prototype.verifyDds
    );
    expect(scopes).toEqual(['traceability:read']);
  });
});

describe('TraceabilityPartnerController identity plumbing', () => {
  it('creates shipments under the authenticated partner client id', async () => {
    const { controller, service } = makeController();
    await controller.createShipment({ lotIds: ['lot-1'] }, request('acme-export'));
    expect(service.createShipmentForPartner).toHaveBeenCalledWith('acme-export', {
      lotIds: ['lot-1']
    });
  });

  it('fetches and verifies DDS under the authenticated partner client id', async () => {
    const { controller, service } = makeController();
    await controller.fetchDds('tsh-1', request('acme-export'));
    expect(service.exportDdsForPartner).toHaveBeenCalledWith('acme-export', 'tsh-1');
    await controller.verifyDds('tsh-1', request('acme-export'));
    expect(service.verifyShipmentChainForPartner).toHaveBeenCalledWith('acme-export', 'tsh-1');
  });
});
