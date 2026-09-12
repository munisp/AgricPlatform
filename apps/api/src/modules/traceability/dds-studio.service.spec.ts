import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { InMemoryDdsPackageRepository } from '../../database/repositories/dds-package.repository.js';
import {
  InMemoryCommodityLotRepository,
  InMemoryCustodyEventRepository,
  InMemoryLotPlotLinkRepository,
  InMemoryTraceabilityShipmentRepository
} from '../../database/repositories/traceability.repository.js';
import { DdsStudioService } from './dds-studio.service.js';
import {
  computeEventHash,
  GENESIS_PREV_HASH,
  hashPayloadOf,
  type CommodityLot,
  type CustodyEvent,
  type LotPlotLink,
  type TraceabilityShipment
} from './traceability.types.js';

/**
 * DDS Studio service flows (stage 27 innovation 17): draft → validate →
 * export with the guarded status CAS, event + audit emissions, partner
 * confinement and export determinism (same shipment + evidence → same
 * package_hash; exported packages are immutable).
 */

const farmer = { id: 'user-farmer', roles: ['farmer'] } as User;
const admin = { id: 'user-admin', roles: ['admin'] } as User;
const stranger = { id: 'user-stranger', roles: ['farmer'] } as User;

function makeChainedEvent(
  lotId: string,
  seq: number,
  type: CustodyEvent['type'],
  prevEventHash: string,
  occurredAt: string
): CustodyEvent {
  const unsigned = {
    lotId,
    seq,
    type,
    actorId: 'user-farmer',
    occurredAt,
    latitude: 11.0855,
    longitude: 7.7199,
    parentLotIds: [] as string[],
    prevEventHash
  };
  return {
    id: `evt-${lotId}-${seq}`,
    ...unsigned,
    eventHash: computeEventHash(hashPayloadOf(unsigned)),
    createdAt: occurredAt
  };
}

function seedLot(lots: InMemoryCommodityLotRepository, overrides: Partial<CommodityLot> = {}) {
  const lot: CommodityLot = {
    id: 'lot-1',
    ownerUserId: farmer.id,
    crop: 'Cocoa',
    harvestWindowStart: '2026-01-01T00:00:00.000Z',
    harvestWindowEnd: '2026-03-01T00:00:00.000Z',
    quantity: 500,
    unit: 'kg',
    status: 'active',
    parentLotIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
  return lots.create(lot);
}

async function seedChain(events: InMemoryCustodyEventRepository, lotId: string) {
  const first = makeChainedEvent(lotId, 0, 'CREATED', GENESIS_PREV_HASH, '2026-02-01T00:00:00.000Z');
  const second = makeChainedEvent(lotId, 1, 'SHIPPED', first.eventHash, '2026-02-15T00:00:00.000Z');
  await events.append(first);
  await events.append(second);
}

function seedSnapshot(links: InMemoryLotPlotLinkRepository, lotId: string) {
  const link: LotPlotLink = {
    id: `lpl-${lotId}-1`,
    lotId,
    plotId: 'plot-1',
    plotOwnerUserId: farmer.id,
    plotName: 'Zaria North Plot',
    latitude: 11.0855,
    longitude: 7.7199,
    linkedAt: '2026-01-10T00:00:00.000Z',
    linkedBy: farmer.id
  };
  return links.create(link);
}

function makeService() {
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const events = { publish: vi.fn().mockResolvedValue({}) } as unknown as DomainEventsService;
  const lots = new InMemoryCommodityLotRepository();
  const custodyEvents = new InMemoryCustodyEventRepository();
  const plotLinks = new InMemoryLotPlotLinkRepository();
  const shipments = new InMemoryTraceabilityShipmentRepository();
  const packages = new InMemoryDdsPackageRepository();
  const service = new DdsStudioService(
    audit,
    events,
    lots,
    custodyEvents,
    plotLinks,
    shipments,
    packages
  );
  return { service, audit, events, lots, custodyEvents, plotLinks, shipments, packages };
}

async function seedShipment(
  ctx: ReturnType<typeof makeService>,
  options: { complete?: boolean; creatorId?: string; creatorKind?: 'user' | 'partner' } = {}
) {
  const { complete = true, creatorId = farmer.id, creatorKind = 'user' } = options;
  await seedLot(ctx.lots);
  if (complete) {
    await seedChain(ctx.custodyEvents, 'lot-1');
    await seedSnapshot(ctx.plotLinks, 'lot-1');
  }
  const shipment: TraceabilityShipment = {
    id: 'tsh-1',
    creatorId,
    creatorKind,
    reference: 'EXP-2026-001',
    status: 'created',
    createdAt: '2026-02-20T00:00:00.000Z',
    updatedAt: '2026-02-20T00:00:00.000Z'
  };
  await ctx.shipments.create(shipment, [
    { id: 'tsl-1', shipmentId: shipment.id, lotId: 'lot-1', position: 0 }
  ]);
  return shipment;
}

describe('DdsStudioService — draft creation', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('creates a draft package and emits traceability.dds.created with tenant.id', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    expect(pkg.status).toBe('draft');
    expect(pkg.checklist).toEqual([]);
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.dds.created',
      expect.objectContaining({ packageId: pkg.id, shipmentId: 'tsh-1', tenantId: 'user:user-farmer' }),
      farmer.id
    );
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'traceability.dds_package_created', entityId: pkg.id })
    );
  });

  it('requires authentication', async () => {
    await seedShipment(ctx);
    await expect(ctx.service.createDraftForUser(null, 'tsh-1')).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('refuses users who cannot read the shipment', async () => {
    await seedShipment(ctx);
    await expect(ctx.service.createDraftForUser(stranger, 'tsh-1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('partner drafts are confined to partner-created shipments', async () => {
    await seedShipment(ctx, { creatorId: 'partner:acme-export', creatorKind: 'partner' });
    const pkg = await ctx.service.createDraftForPartner('acme-export', 'tsh-1');
    expect(pkg.exporterPartnerId).toBe('acme-export');
    await expect(ctx.service.createDraftForPartner('other-export', 'tsh-1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

describe('DdsStudioService — validation', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('a complete shipment validates to pass and moves draft → validated', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    const { package: saved, validation } = await ctx.service.validateForUser(farmer, pkg.id);
    expect(validation.result).toBe('pass');
    expect(saved.status).toBe('validated');
    expect(saved.checklist.length).toBeGreaterThan(0);
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.dds.validated',
      expect.objectContaining({ packageId: pkg.id, result: 'pass', tenantId: 'user:user-farmer' }),
      farmer.id
    );
  });

  it('incomplete evidence fails loudly, names the missing item and STAYS draft (never auto-passed)', async () => {
    await seedShipment(ctx, { complete: false }); // no custody events, no plot snapshot
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    const { package: saved, validation } = await ctx.service.validateForUser(farmer, pkg.id);
    expect(validation.result).toBe('fail');
    expect(saved.status).toBe('draft');
    const missing = validation.items.flatMap((entry) => entry.missing ?? []);
    expect(missing).toContain('lot:lot-1:plot_snapshot');
    expect(missing).toContain('lot:lot-1:custody_events');
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.dds.validated',
      expect.objectContaining({
        result: 'fail',
        failedRequirements: expect.arrayContaining(['lot_geolocation_snapshot', 'custody_chain_continuity'])
      }),
      farmer.id
    );
  });

  it('refuses to validate an exported package (immutability after export)', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await ctx.service.validateForUser(farmer, pkg.id);
    await ctx.service.exportForUser(farmer, pkg.id);
    await expect(ctx.service.validateForUser(farmer, pkg.id)).rejects.toBeInstanceOf(
      ConflictException
    );
  });
});

describe('DdsStudioService — export', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('fails closed: a draft package cannot be exported', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await expect(ctx.service.exportForUser(farmer, pkg.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('fails closed: a FAILED validation cannot be exported', async () => {
    await seedShipment(ctx, { complete: false });
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await ctx.service.validateForUser(farmer, pkg.id);
    await expect(ctx.service.exportForUser(farmer, pkg.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('exports a validated package with hash manifest, audit anchor and event', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await ctx.service.validateForUser(farmer, pkg.id);
    const doc = await ctx.service.exportForUser(farmer, pkg.id);
    expect(doc.status).toBe('exported');
    expect(doc.packageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.dds.ddsReference).toBe('tsh-1');
    expect(doc.dds.countryOfProduction).toBe('NG');
    expect(doc.dds.productionPlots).toHaveLength(1);
    expect(doc.evidenceAnnex.lots[0].custodyEventHashes).toHaveLength(2);
    // Audit-chain anchor on export carries the package hash.
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'traceability.dds_package_exported',
        entityId: pkg.id,
        metadata: expect.objectContaining({ packageHash: doc.packageHash })
      })
    );
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.dds.exported',
      expect.objectContaining({ packageId: pkg.id, packageHash: doc.packageHash, tenantId: 'user:user-farmer' }),
      farmer.id
    );
  });

  it('export is deterministic: re-export returns the same package_hash', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await ctx.service.validateForUser(farmer, pkg.id);
    const first = await ctx.service.exportForUser(farmer, pkg.id);
    const second = await ctx.service.exportForUser(farmer, pkg.id);
    expect(second.packageHash).toBe(first.packageHash);
    expect(second.exportedAt).toBe(first.exportedAt);
    expect(second.evidenceAnnex).toEqual(first.evidenceAnnex);
  });

  it('the guarded CAS rejects a second markExported (immutability at the repository)', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    await ctx.service.validateForUser(farmer, pkg.id);
    await ctx.service.exportForUser(farmer, pkg.id);
    await expect(
      ctx.packages.markExported(pkg.id, '0'.repeat(64), new Date().toISOString())
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(ctx.packages.saveChecklist(pkg.id, 'draft', [])).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('partner exports are confined to the creating client', async () => {
    await seedShipment(ctx, { creatorId: 'partner:acme-export', creatorKind: 'partner' });
    const pkg = await ctx.service.createDraftForPartner('acme-export', 'tsh-1');
    await expect(ctx.service.exportForPartner('other-export', pkg.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(ctx.service.validateForPartner('other-export', pkg.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(ctx.service.getPackageForPartner('other-export', pkg.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('admins may read and operate any package', async () => {
    await seedShipment(ctx);
    const pkg = await ctx.service.createDraftForUser(farmer, 'tsh-1');
    const { validation } = await ctx.service.validateForUser(admin, pkg.id);
    expect(validation.result).toBe('pass');
    const doc = await ctx.service.exportForUser(admin, pkg.id);
    expect(doc.status).toBe('exported');
  });
});
