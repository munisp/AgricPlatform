import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import { ROLES_KEY } from '../../common/auth/roles.decorator.js';
import { LivestockPassportController } from './livestock-passport.controller.js';
import type { LivestockPassportService } from './livestock-passport.service.js';

/**
 * Route/auth wiring for the livestock passport surface (wave-livestock-
 * passport). The RBAC matrix itself lives in the service specs; here we pin
 * that the PUBLIC verification route carries no role metadata (the
 * RolesGuard admits it unauthenticated) while every other route is
 * authenticated, and that each handler delegates to the service with the
 * caller identity.
 */
function makeController() {
  const service = {
    issuePassport: vi.fn().mockResolvedValue({ passport: { id: 'lsp-1' } }),
    listMine: vi.fn().mockResolvedValue([]),
    verifyPublic: vi.fn().mockResolvedValue({ verified: true }),
    listMyTransfers: vi.fn().mockResolvedValue([]),
    confirmTransfer: vi.fn().mockResolvedValue({ id: 'lspt-1', status: 'confirmed' }),
    cancelTransfer: vi.fn().mockResolvedValue({ id: 'lspt-1', status: 'cancelled' }),
    oversightExport: vi.fn().mockResolvedValue([]),
    authorityStatus: vi.fn().mockResolvedValue({ configured: true, healthy: true }),
    getPassport: vi.fn().mockResolvedValue({ passport: { id: 'lsp-1' } }),
    getEvents: vi.fn().mockResolvedValue({ events: [] }),
    initiateTransfer: vi.fn().mockResolvedValue({ id: 'lspt-1', status: 'pending' }),
    suspend: vi.fn().mockResolvedValue({ id: 'lsp-1', status: 'suspended' }),
    reinstate: vi.fn().mockResolvedValue({ id: 'lsp-1', status: 'active' })
  } as unknown as LivestockPassportService;
  return { controller: new LivestockPassportController(service), service };
}

const farmer = { id: 'farmer-1', roles: ['farmer'] } as User;

describe('LivestockPassportController auth metadata', () => {
  it('GET verify/:code is PUBLIC (no roles metadata)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, LivestockPassportController.prototype.verifyPublic);
    expect(roles).toBeUndefined();
  });

  it.each([
    'issuePassport',
    'listMine',
    'listTransfers',
    'confirmTransfer',
    'cancelTransfer',
    'oversightExport',
    'authorityStatus',
    'getPassport',
    'getEvents',
    'initiateTransfer',
    'suspend',
    'reinstate'
  ] as const)('%s requires an authenticated identity', (method) => {
    const roles = Reflect.getMetadata(ROLES_KEY, LivestockPassportController.prototype[method]);
    expect(Array.isArray(roles)).toBe(true);
    expect(roles.length).toBeGreaterThan(0);
  });
});

describe('LivestockPassportController delegation', () => {
  it('issues a passport for the path animal with the caller identity', async () => {
    const { controller, service } = makeController();
    const result = await controller.issuePassport('NG-BOV-KD-000123', farmer);
    expect(service.issuePassport).toHaveBeenCalledWith(farmer, { animalId: 'NG-BOV-KD-000123' });
    expect(result.data).toEqual({ passport: { id: 'lsp-1' } });
  });

  it('verifies a public code without requiring an actor', async () => {
    const { controller, service } = makeController();
    const result = await controller.verifyPublic('LSP.NG-BOV-KD-000123.ab12cd34.0123456789abcdef');
    expect(service.verifyPublic).toHaveBeenCalledWith(
      'LSP.NG-BOV-KD-000123.ab12cd34.0123456789abcdef'
    );
    expect(result.data).toEqual({ verified: true });
  });

  it('initiates a transfer with the dto and caller identity', async () => {
    const { controller, service } = makeController();
    await controller.initiateTransfer('lsp-1', { toUserId: 'buyer-1' }, farmer);
    expect(service.initiateTransfer).toHaveBeenCalledWith(farmer, 'lsp-1', { toUserId: 'buyer-1' });
  });

  it('confirms and cancels transfers as the caller', async () => {
    const { controller, service } = makeController();
    await controller.confirmTransfer('lspt-1', farmer);
    expect(service.confirmTransfer).toHaveBeenCalledWith(farmer, 'lspt-1');
    await controller.cancelTransfer('lspt-1', farmer);
    expect(service.cancelTransfer).toHaveBeenCalledWith(farmer, 'lspt-1');
  });

  it('defaults the transfer list direction to incoming', async () => {
    const { controller, service } = makeController();
    await controller.listTransfers({}, farmer);
    expect(service.listMyTransfers).toHaveBeenCalledWith(farmer, 'incoming');
    await controller.listTransfers({ direction: 'outgoing' }, farmer);
    expect(service.listMyTransfers).toHaveBeenCalledWith(farmer, 'outgoing');
  });

  it('delegates oversight export, events and status transitions', async () => {
    const { controller, service } = makeController();
    await controller.oversightExport(farmer);
    expect(service.oversightExport).toHaveBeenCalledWith(farmer);
    await controller.getEvents('lsp-1', farmer);
    expect(service.getEvents).toHaveBeenCalledWith(farmer, 'lsp-1');
    await controller.suspend('lsp-1', farmer);
    expect(service.suspend).toHaveBeenCalledWith(farmer, 'lsp-1');
    await controller.reinstate('lsp-1', farmer);
    expect(service.reinstate).toHaveBeenCalledWith(farmer, 'lsp-1');
  });
});
