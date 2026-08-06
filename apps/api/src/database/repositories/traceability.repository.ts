import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  CommodityLot,
  CustodyEvent,
  LotPlotLink,
  LotStatus,
  ShipmentLot,
  TraceabilityShipment
} from '../../modules/traceability/traceability.types.js';

/**
 * EUDR traceability persistence ports (wave-eudr, migrations 029/030).
 * Deliberately NOT the generic AsyncRepository port for custody_events and
 * lot_plot_links: those tables are append-only, so their ports expose no
 * update/remove at all — app-level append-only plus the sha256 hash chain is
 * the integrity mechanism (DB triggers are intentionally avoided; see
 * docs/eudr-traceability.md). Both implementations (in-memory here, pg in
 * traceability.pg-repository.ts) must stay behaviourally identical.
 */

// ---------------------------------------------------------------------------
// Commodity lots (traceability.commodity_lots)
// ---------------------------------------------------------------------------

export interface CommodityLotCriteria {
  ownerUserId?: string;
  crop?: string;
  status?: LotStatus;
}

export interface CommodityLotRepository {
  create(lot: CommodityLot): Promise<CommodityLot>;
  findById(id: string): Promise<CommodityLot | undefined>;
  getById(id: string): Promise<CommodityLot>;
  find(criteria: CommodityLotCriteria): Promise<CommodityLot[]>;
  /** Mutable fields only: status/quantity/updatedAt (genealogy is fixed). */
  update(
    id: string,
    patch: Partial<Pick<CommodityLot, 'status' | 'quantity' | 'updatedAt'>>
  ): Promise<CommodityLot>;
}

export class InMemoryCommodityLotRepository implements CommodityLotRepository {
  private readonly items = new Map<string, CommodityLot>();

  constructor(seed: readonly CommodityLot[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(lot: CommodityLot): Promise<CommodityLot> {
    if (this.items.has(lot.id)) {
      throw new ConflictException(`Commodity lot '${lot.id}' already exists`);
    }
    this.items.set(lot.id, structuredClone(lot));
    return lot;
  }

  async findById(id: string): Promise<CommodityLot | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<CommodityLot> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Commodity lot '${id}' not found`);
    }
    return item;
  }

  async find(criteria: CommodityLotCriteria): Promise<CommodityLot[]> {
    return [...this.items.values()]
      .filter(
        (lot) =>
          (!criteria.ownerUserId || lot.ownerUserId === criteria.ownerUserId) &&
          (!criteria.crop || lot.crop === criteria.crop) &&
          (!criteria.status || lot.status === criteria.status)
      )
      .map((lot) => structuredClone(lot));
  }

  async update(
    id: string,
    patch: Partial<Pick<CommodityLot, 'status' | 'quantity' | 'updatedAt'>>
  ): Promise<CommodityLot> {
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Commodity lot '${id}' not found`);
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryCommodityLotRepository(): InMemoryCommodityLotRepository {
  return new InMemoryCommodityLotRepository();
}

// ---------------------------------------------------------------------------
// Custody events (traceability.custody_events) — APPEND-ONLY
// ---------------------------------------------------------------------------

export interface CustodyEventCriteria {
  lotId?: string;
  type?: CustodyEvent['type'];
}

export interface CustodyEventRepository {
  /**
   * Appends an event. Throws ConflictException when the event_hash or the
   * (lot_id, seq) pair already exists — a rewritten history collides here.
   */
  append(event: CustodyEvent): Promise<CustodyEvent>;
  findById(id: string): Promise<CustodyEvent | undefined>;
  find(criteria: CustodyEventCriteria): Promise<CustodyEvent[]>;
  /** Events of one lot in chain order (ascending seq). */
  listByLot(lotId: string): Promise<CustodyEvent[]>;
  /** Current chain length for a lot (next seq). */
  countByLot(lotId: string): Promise<number>;
}

export class InMemoryCustodyEventRepository implements CustodyEventRepository {
  private readonly items = new Map<string, CustodyEvent>();

  constructor(seed: readonly CustodyEvent[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async append(event: CustodyEvent): Promise<CustodyEvent> {
    for (const existing of this.items.values()) {
      if (existing.eventHash === event.eventHash) {
        throw new ConflictException('A custody event with this event_hash already exists');
      }
      if (existing.lotId === event.lotId && existing.seq === event.seq) {
        throw new ConflictException(
          `Custody event seq ${event.seq} already exists for lot '${event.lotId}'`
        );
      }
    }
    this.items.set(event.id, structuredClone(event));
    return event;
  }

  async findById(id: string): Promise<CustodyEvent | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async find(criteria: CustodyEventCriteria): Promise<CustodyEvent[]> {
    return [...this.items.values()]
      .filter(
        (event) =>
          (!criteria.lotId || event.lotId === criteria.lotId) &&
          (!criteria.type || event.type === criteria.type)
      )
      .map((event) => structuredClone(event));
  }

  async listByLot(lotId: string): Promise<CustodyEvent[]> {
    return (await this.find({ lotId })).sort((a, b) => a.seq - b.seq);
  }

  async countByLot(lotId: string): Promise<number> {
    return (await this.find({ lotId })).length;
  }
}

export function createInMemoryCustodyEventRepository(): InMemoryCustodyEventRepository {
  return new InMemoryCustodyEventRepository();
}

// ---------------------------------------------------------------------------
// Lot plot links (traceability.lot_plot_links) — APPEND-ONLY snapshots
// ---------------------------------------------------------------------------

export interface LotPlotLinkCriteria {
  lotId?: string;
  plotId?: string;
}

export interface LotPlotLinkRepository {
  create(link: LotPlotLink): Promise<LotPlotLink>;
  find(criteria: LotPlotLinkCriteria): Promise<LotPlotLink[]>;
}

export class InMemoryLotPlotLinkRepository implements LotPlotLinkRepository {
  private readonly items = new Map<string, LotPlotLink>();

  constructor(seed: readonly LotPlotLink[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async create(link: LotPlotLink): Promise<LotPlotLink> {
    if (this.items.has(link.id)) {
      throw new ConflictException(`Lot plot link '${link.id}' already exists`);
    }
    this.items.set(link.id, structuredClone(link));
    return link;
  }

  async find(criteria: LotPlotLinkCriteria): Promise<LotPlotLink[]> {
    return [...this.items.values()]
      .filter(
        (link) =>
          (!criteria.lotId || link.lotId === criteria.lotId) &&
          (!criteria.plotId || link.plotId === criteria.plotId)
      )
      .map((link) => structuredClone(link));
  }
}

export function createInMemoryLotPlotLinkRepository(): InMemoryLotPlotLinkRepository {
  return new InMemoryLotPlotLinkRepository();
}

// ---------------------------------------------------------------------------
// Shipments (traceability.shipments + traceability.shipment_lots)
// ---------------------------------------------------------------------------

export interface TraceabilityShipmentCriteria {
  creatorId?: string;
  status?: TraceabilityShipment['status'];
}

export interface TraceabilityShipmentRepository {
  create(shipment: TraceabilityShipment, lots: readonly ShipmentLot[]): Promise<TraceabilityShipment>;
  findById(id: string): Promise<TraceabilityShipment | undefined>;
  getById(id: string): Promise<TraceabilityShipment>;
  find(criteria: TraceabilityShipmentCriteria): Promise<TraceabilityShipment[]>;
  /** Lot composition in declared order. */
  listLots(shipmentId: string): Promise<ShipmentLot[]>;
  /** Status transition only ('created' → 'exported'). */
  updateStatus(id: string, status: TraceabilityShipment['status']): Promise<TraceabilityShipment>;
}

export class InMemoryTraceabilityShipmentRepository implements TraceabilityShipmentRepository {
  private readonly shipments = new Map<string, TraceabilityShipment>();
  private readonly lots = new Map<string, ShipmentLot>();

  async create(
    shipment: TraceabilityShipment,
    lots: readonly ShipmentLot[]
  ): Promise<TraceabilityShipment> {
    if (this.shipments.has(shipment.id)) {
      throw new ConflictException(`Shipment '${shipment.id}' already exists`);
    }
    this.shipments.set(shipment.id, structuredClone(shipment));
    for (const lot of lots) {
      this.lots.set(lot.id, structuredClone(lot));
    }
    return shipment;
  }

  async findById(id: string): Promise<TraceabilityShipment | undefined> {
    const item = this.shipments.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async getById(id: string): Promise<TraceabilityShipment> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Traceability shipment '${id}' not found`);
    }
    return item;
  }

  async find(criteria: TraceabilityShipmentCriteria): Promise<TraceabilityShipment[]> {
    return [...this.shipments.values()]
      .filter(
        (shipment) =>
          (!criteria.creatorId || shipment.creatorId === criteria.creatorId) &&
          (!criteria.status || shipment.status === criteria.status)
      )
      .map((shipment) => structuredClone(shipment));
  }

  async listLots(shipmentId: string): Promise<ShipmentLot[]> {
    return [...this.lots.values()]
      .filter((lot) => lot.shipmentId === shipmentId)
      .sort((a, b) => a.position - b.position)
      .map((lot) => structuredClone(lot));
  }

  async updateStatus(
    id: string,
    status: TraceabilityShipment['status']
  ): Promise<TraceabilityShipment> {
    const current = this.shipments.get(id);
    if (!current) {
      throw new NotFoundException(`Traceability shipment '${id}' not found`);
    }
    const next = { ...current, status, updatedAt: new Date().toISOString() };
    this.shipments.set(id, next);
    return structuredClone(next);
  }
}

export function createInMemoryTraceabilityShipmentRepository(): InMemoryTraceabilityShipmentRepository {
  return new InMemoryTraceabilityShipmentRepository();
}
