import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FarmPlot, User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import {
  InMemoryCommodityLotRepository,
  InMemoryCustodyEventRepository,
  InMemoryLotPlotLinkRepository,
  InMemoryTraceabilityShipmentRepository
} from '../../database/repositories/traceability.repository.js';
import type { FarmsService } from '../farms/farms.service.js';
import type { GeoIntelService } from '../geo-intel/geo-intel.service.js';
import { TraceabilityService } from './traceability.service.js';
import { GENESIS_PREV_HASH, type CustodyEvent } from './traceability.types.js';

const farmer = { id: 'user-farmer', roles: ['farmer'] } as User;
const otherFarmer = { id: 'user-other', roles: ['farmer'] } as User;
const aggregator = { id: 'user-agg', roles: ['buyer'] } as User;
const admin = { id: 'user-admin', roles: ['admin'] } as User;

const PLOT = {
  id: 'plot-1',
  ownerUserId: 'user-farmer',
  name: 'Zaria North Plot',
  state: 'Kaduna',
  lga: 'Zaria',
  centroidLat: 11.0855,
  centroidLong: 7.7199,
  sizeHectares: 2.5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1
} as FarmPlot;

const LOT_INPUT = {
  crop: 'Cocoa',
  harvestWindowStart: '2026-01-01T00:00:00.000Z',
  harvestWindowEnd: '2026-03-01T00:00:00.000Z',
  quantity: 500,
  unit: 'kg'
};

const EVENT_INPUT = {
  type: 'SHIPPED' as const,
  occurredAt: '2026-02-01T00:00:00.000Z',
  latitude: 11.0855,
  longitude: 7.7199
};

function makeService(options: { geoIntel?: 'stub' | 'http' | 'down' | 'absent'; plots?: FarmPlot[] } = {}) {
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const events = { publish: vi.fn().mockResolvedValue({}) } as unknown as DomainEventsService;
  const lots = new InMemoryCommodityLotRepository();
  const custody = new InMemoryCustodyEventRepository();
  const links = new InMemoryLotPlotLinkRepository();
  const shipments = new InMemoryTraceabilityShipmentRepository();
  const farms = {
    getPlot: vi.fn(async (_actor: User | null, id: string) => {
      const plot = (options.plots ?? [PLOT]).find((candidate) => candidate.id === id);
      if (!plot) {
        throw new NotFoundException(`plot '${id}' not found`);
      }
      return plot;
    })
  } as unknown as FarmsService;
  let geoIntel: GeoIntelService | undefined;
  if (options.geoIntel && options.geoIntel !== 'absent') {
    geoIntel = {
      assessFloodRisk: vi.fn(async () => {
        if (options.geoIntel === 'down') {
          throw new ServiceUnavailableException('flood-ml sidecar unreachable');
        }
        return {
          driver: options.geoIntel === 'http' ? 'http' : 'stub',
          floodDetected: false,
          severity: 'low',
          source: options.geoIntel === 'http' ? 'flood-ml' : 'simulated-fixture'
        };
      })
    } as unknown as GeoIntelService;
  }
  const service = new TraceabilityService(audit, events, lots, custody, links, shipments, farms, geoIntel);
  return { service, audit, events, lots, custody, links, shipments, farms, geoIntel };
}

describe('TraceabilityService lots', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('creates a lot owned by the caller and publishes traceability.lot.created', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    expect(lot.ownerUserId).toBe('user-farmer');
    expect(lot.status).toBe('active');
    expect(lot.parentLotIds).toEqual([]);
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.lot.created',
      expect.objectContaining({ lotId: lot.id }),
      'user-farmer'
    );
  });

  it('rejects unauthenticated lot creation (401)', async () => {
    await expect(ctx.service.createLot(null, LOT_INPUT)).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it('rejects non-positive quantity and inverted harvest windows (400)', async () => {
    await expect(
      ctx.service.createLot(farmer, { ...LOT_INPUT, quantity: 0 })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.createLot(farmer, {
        ...LOT_INPUT,
        harvestWindowEnd: '2025-01-01T00:00:00.000Z'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes listLots: non-admins see only their own; admins may filter', async () => {
    await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.createLot(otherFarmer, LOT_INPUT);
    expect(await ctx.service.listLots(farmer)).toHaveLength(1);
    expect(await ctx.service.listLots(admin)).toHaveLength(2);
    expect(await ctx.service.listLots(admin, 'user-other')).toHaveLength(1);
  });

  it('forbids non-admins from listing another owner explicitly', async () => {
    await expect(ctx.service.listLots(farmer, 'user-other')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('getLot enforces ownership: strangers 403, owner and admin pass', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(ctx.service.getLot(otherFarmer, lot.id)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect((await ctx.service.getLot(farmer, lot.id)).id).toBe(lot.id);
    expect((await ctx.service.getLot(admin, lot.id)).id).toBe(lot.id);
  });
});

describe('TraceabilityService custody chain', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('chains events: genesis prev for the first, head hash for the next, seq increments', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    const first = await ctx.service.addCustodyEvent(farmer, lot.id, {
      ...EVENT_INPUT,
      type: 'CREATED'
    });
    expect(first.seq).toBe(0);
    expect(first.prevEventHash).toBe(GENESIS_PREV_HASH);
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    const second = await ctx.service.addCustodyEvent(farmer, lot.id, EVENT_INPUT);
    expect(second.seq).toBe(1);
    expect(second.prevEventHash).toBe(first.eventHash);
    expect(second.eventHash).not.toBe(first.eventHash);
  });

  it('marks lots shipped/received from custody events', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.addCustodyEvent(farmer, lot.id, EVENT_INPUT);
    expect((await ctx.service.getLot(farmer, lot.id)).status).toBe('shipped');
    await ctx.service.addCustodyEvent(aggregator, lot.id, {
      ...EVENT_INPUT,
      type: 'RECEIVED'
    });
    expect((await ctx.service.getLot(farmer, lot.id)).status).toBe('received');
  });

  it('restricts CREATED events to the owner (aggregator 403)', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.addCustodyEvent(aggregator, lot.id, { ...EVENT_INPUT, type: 'CREATED' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets aggregators append hand-off events and then read the lot (custody trail)', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.addCustodyEvent(aggregator, lot.id, {
      ...EVENT_INPUT,
      type: 'TRANSFORMED'
    });
    expect((await ctx.service.getLot(aggregator, lot.id)).id).toBe(lot.id);
  });

  it('rejects invalid coordinates and non-positive quantities (400)', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.addCustodyEvent(farmer, lot.id, { ...EVENT_INPUT, latitude: 91 })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.addCustodyEvent(farmer, lot.id, { ...EVENT_INPUT, quantity: -1 })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('timeline returns a recomputed verification that passes', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.addCustodyEvent(farmer, lot.id, { ...EVENT_INPUT, type: 'CREATED' });
    await ctx.service.addCustodyEvent(farmer, lot.id, EVENT_INPUT);
    const timeline = await ctx.service.timeline(farmer, lot.id);
    expect(timeline.events).toHaveLength(2);
    expect(timeline.verification.valid).toBe(true);
    expect(timeline.verification.events.every((event) => event.valid)).toBe(true);
  });

  it('publishes traceability.custody.recorded per event', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.addCustodyEvent(farmer, lot.id, EVENT_INPUT);
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.custody.recorded',
      expect.objectContaining({ lotId: lot.id, type: 'SHIPPED', seq: 0 }),
      'user-farmer'
    );
  });
});

describe('TraceabilityService genealogy', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  async function lotWithPlot() {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    return lot;
  }

  it('split: child keeps parent ref, parent quantity shrinks, plot snapshots copied', async () => {
    const parent = await lotWithPlot();
    const { parent: updated, child } = await ctx.service.splitLot(farmer, parent.id, {
      quantity: 200,
      occurredAt: '2026-02-01T00:00:00.000Z',
      latitude: 11.0855,
      longitude: 7.7199
    });
    expect(updated.quantity).toBe(300);
    expect(updated.status).toBe('split');
    expect(child.parentLotIds).toEqual([parent.id]);
    expect(child.quantity).toBe(200);
    const childLinks = await ctx.service.listPlotLinks(farmer, child.id);
    expect(childLinks).toHaveLength(1);
    expect(childLinks[0].plotId).toBe(PLOT.id);
    const childTrail = await ctx.custody.listByLot(child.id);
    expect(childTrail[0].type).toBe('CREATED');
    expect(childTrail[0].parentLotIds).toEqual([parent.id]);
    const parentTrail = await ctx.custody.listByLot(parent.id);
    expect(parentTrail[0].type).toBe('SPLIT');
  });

  it('split rejects quantity >= lot quantity', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.splitLot(farmer, lot.id, {
        quantity: 500,
        occurredAt: '2026-02-01T00:00:00.000Z',
        latitude: 11.0855,
        longitude: 7.7199
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('aggregate: many parents, parents marked aggregated, child AGGREGATED event lists them', async () => {
    const a = await lotWithPlot();
    const b = await ctx.service.createLot(otherFarmer, { ...LOT_INPUT, quantity: 250 });
    const child = await ctx.service.aggregateLots(aggregator, {
      parentLotIds: [b.id, a.id],
      crop: 'Cocoa',
      quantity: 750,
      unit: 'kg',
      occurredAt: '2026-02-10T00:00:00.000Z',
      latitude: 11.1,
      longitude: 7.8
    });
    expect(child.parentLotIds).toEqual([b.id, a.id]);
    expect(child.ownerUserId).toBe('user-agg');
    expect((await ctx.lots.getById(a.id)).status).toBe('aggregated');
    expect((await ctx.lots.getById(b.id)).status).toBe('aggregated');
    const trail = await ctx.custody.listByLot(child.id);
    expect(trail[0].type).toBe('AGGREGATED');
    // Sorted inside the hash payload (id order is uuid-random).
    expect([...trail[0].parentLotIds].sort()).toEqual([a.id, b.id].sort());
    // Plot snapshot union inherited from parents.
    const links = await ctx.links.find({ lotId: child.id });
    expect(links.map((link) => link.plotId)).toContain(PLOT.id);
  });

  it('aggregate requires at least two parents and custody access', async () => {
    const a = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.aggregateLots(aggregator, {
        parentLotIds: [a.id],
        crop: 'Cocoa',
        quantity: 100,
        unit: 'kg',
        occurredAt: '2026-02-10T00:00:00.000Z',
        latitude: 11.1,
        longitude: 7.8
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    const b = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.aggregateLots(otherFarmer, {
        parentLotIds: [a.id, b.id],
        crop: 'Cocoa',
        quantity: 100,
        unit: 'kg',
        occurredAt: '2026-02-10T00:00:00.000Z',
        latitude: 11.1,
        longitude: 7.8
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TraceabilityService plot snapshots', () => {
  it('copies geometry at link time; later plot edits never rewrite the snapshot', async () => {
    const ctx = makeService();
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    const link = await ctx.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    expect(link.latitude).toBe(11.0855);
    expect(link.plotOwnerUserId).toBe('user-farmer');
    // Plot moves (boundary re-survey) — the snapshot stays as evidence.
    (ctx.farms.getPlot as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...PLOT,
      centroidLat: 9.0,
      centroidLong: 8.0
    } as FarmPlot);
    const links = await ctx.service.listPlotLinks(farmer, lot.id);
    expect(links[0].latitude).toBe(11.0855);
    expect(links[0].longitude).toBe(7.7199);
  });

  it('rejects duplicate plot links and non-owner linking', async () => {
    const ctx = makeService();
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    await expect(
      ctx.service.linkPlot(farmer, lot.id, { plotId: PLOT.id })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ctx.service.linkPlot(otherFarmer, lot.id, { plotId: 'plot-9' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('TraceabilityService shipments + DDS', () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService({ geoIntel: 'stub' });
  });

  async function shipmentFixture() {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await ctx.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    await ctx.service.addCustodyEvent(farmer, lot.id, { ...EVENT_INPUT, type: 'CREATED' });
    await ctx.service.addCustodyEvent(farmer, lot.id, EVENT_INPUT);
    const { shipment } = await ctx.service.createShipment(farmer, { lotIds: [lot.id] });
    return { lot, shipment };
  }

  it('createShipment refuses lots the caller cannot read', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    await expect(
      ctx.service.createShipment(otherFarmer, { lotIds: [lot.id] })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('exportDds returns the EUDR-aligned shape with a placeholder operator block', async () => {
    const { shipment } = await shipmentFixture();
    const dds = await ctx.service.exportDds(farmer, shipment.id);
    expect(dds.statementVersion).toBe('1.0');
    expect(dds.ddsReference).toBe(shipment.id);
    expect(dds.operator.status).toBe('TO_BE_COMPLETED_BY_EXPORTER');
    expect(dds.operator.eori).toBeNull();
    expect(dds.commodity.crops).toEqual(['Cocoa']);
    expect(dds.quantity).toEqual({ value: 500, unit: 'kg' });
    expect(dds.countryOfProduction).toBe('NG');
    expect(dds.productionPlots).toHaveLength(1);
    expect(dds.productionPlots[0].latitude).toBe(11.0855);
    expect(dds.harvestWindow.start).toBe(LOT_INPUT.harvestWindowStart);
    expect(dds.custodySummary.eventCount).toBe(2);
    expect(dds.custodySummary.eventTypes).toEqual(['CREATED', 'SHIPPED']);
    expect(dds.chainIntegrity.verified).toBe(true);
    expect(dds.chainIntegrity.eventCount).toBe(2);
    expect(dds.disclaimers.length).toBeGreaterThanOrEqual(3);
    // Export flips the shipment to 'exported'.
    expect((await ctx.shipments.getById(shipment.id)).status).toBe('exported');
  });

  it('DDS risk basis is honest: stub driver → basis stub with simulated source', async () => {
    const { shipment } = await shipmentFixture();
    const dds = await ctx.service.exportDds(farmer, shipment.id);
    expect(dds.deforestationRisk.basis).toBe('stub');
    expect(dds.deforestationRisk.assessments[0].source).toBe('simulated-fixture');
  });

  it('DDS risk basis is honest: live http driver → basis live', async () => {
    const live = makeService({ geoIntel: 'http' });
    const lot = await live.service.createLot(farmer, LOT_INPUT);
    await live.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    const { shipment } = await live.service.createShipment(farmer, { lotIds: [lot.id] });
    const dds = await live.service.exportDds(farmer, shipment.id);
    expect(dds.deforestationRisk.basis).toBe('live');
  });

  it('DDS risk basis is honest: unreachable live provider → basis unavailable (fail-closed)', async () => {
    const down = makeService({ geoIntel: 'down' });
    const lot = await down.service.createLot(farmer, LOT_INPUT);
    await down.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    const { shipment } = await down.service.createShipment(farmer, { lotIds: [lot.id] });
    const dds = await down.service.exportDds(farmer, shipment.id);
    expect(dds.deforestationRisk.basis).toBe('unavailable');
    expect(dds.deforestationRisk.assessments[0].detail).toContain('unreachable');
  });

  it('DDS risk basis is none when geo-intel is absent', async () => {
    const bare = makeService({ geoIntel: 'absent' });
    const lot = await bare.service.createLot(farmer, LOT_INPUT);
    await bare.service.linkPlot(farmer, lot.id, { plotId: PLOT.id });
    const { shipment } = await bare.service.createShipment(farmer, { lotIds: [lot.id] });
    const dds = await bare.service.exportDds(farmer, shipment.id);
    expect(dds.deforestationRisk.basis).toBe('none');
  });

  it('verifyShipmentChain recomputes per-event validity (all valid)', async () => {
    const { lot, shipment } = await shipmentFixture();
    const result = await ctx.service.verifyShipmentChain(farmer, shipment.id);
    expect(result.allValid).toBe(true);
    expect(result.eventCount).toBe(2);
    expect(result.lots[0].lotId).toBe(lot.id);
    expect(result.lots[0].events.every((event) => event.valid)).toBe(true);
  });

  it('tamper detection end-to-end: a flipped byte fails shipment verification', async () => {
    const { lot, shipment } = await shipmentFixture();
    const stored = await ctx.custody.listByLot(lot.id);
    const tampered: CustodyEvent[] = stored.map((event, index) =>
      index === 0 ? { ...event, quantity: 9999 } : event
    );
    const tamperedRepo = new InMemoryCustodyEventRepository(tampered);
    const service = new TraceabilityService(
      ctx.audit,
      ctx.events,
      ctx.lots,
      tamperedRepo,
      ctx.links,
      ctx.shipments,
      ctx.farms,
      ctx.geoIntel
    );
    const result = await service.verifyShipmentChain(farmer, shipment.id);
    expect(result.allValid).toBe(false);
    expect(result.lots[0].events[0].hashValid).toBe(false);
    // The descendant event's prev link still points at the original hash.
    expect(result.lots[0].events[1].prevLinkValid).toBe(false);
    const dds = await service.exportDds(farmer, shipment.id);
    expect(dds.chainIntegrity.verified).toBe(false);
  });

  it('partner flow: create + export + verify scoped to the creating client', async () => {
    const lot = await ctx.service.createLot(farmer, LOT_INPUT);
    const { shipment } = await ctx.service.createShipmentForPartner('acme-export', {
      lotIds: [lot.id]
    });
    expect(shipment.creatorId).toBe('partner:acme-export');
    expect(shipment.creatorKind).toBe('partner');
    const dds = await ctx.service.exportDdsForPartner('acme-export', shipment.id);
    expect(dds.ddsReference).toBe(shipment.id);
    const verify = await ctx.service.verifyShipmentChainForPartner('acme-export', shipment.id);
    expect(verify.shipmentId).toBe(shipment.id);
    await expect(
      ctx.service.exportDdsForPartner('other-export', shipment.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      ctx.service.verifyShipmentChainForPartner('other-export', shipment.id)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('publishes traceability.shipment.created and traceability.dds.exported', async () => {
    const { shipment } = await shipmentFixture();
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.shipment.created',
      expect.objectContaining({ shipmentId: shipment.id }),
      'user-farmer'
    );
    await ctx.service.exportDds(farmer, shipment.id);
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'traceability.dds.exported',
      expect.objectContaining({ shipmentId: shipment.id, chainVerified: true }),
      'user-farmer'
    );
  });
});
