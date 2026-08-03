import type pg from 'pg';
import { NotFoundException } from '@nestjs/common';
import type {
  CommodityLot,
  CustodyEvent,
  LotPlotLink,
  ShipmentLot,
  TraceabilityShipment
} from '../../modules/traceability/traceability.types.js';
import { mapPgError } from '../pg/pg-repository.base.js';
import type {
  CommodityLotCriteria,
  CommodityLotRepository,
  CustodyEventCriteria,
  CustodyEventRepository,
  LotPlotLinkCriteria,
  LotPlotLinkRepository,
  TraceabilityShipmentCriteria,
  TraceabilityShipmentRepository
} from './traceability.repository.js';

/**
 * EUDR traceability pg implementations (wave-eudr, traceability schema,
 * migrations 029/030). Custody events and lot plot links expose NO update or
 * delete statements at all — append-only is enforced by the absence of a
 * write path here, with the hash chain as the tamper-evidence layer.
 * jsonb columns are serialised explicitly (node-pg would otherwise encode JS
 * arrays as Postgres array literals, which do not cast to jsonb).
 */

function str(row: Record<string, unknown>, column: string): string {
  return row[column] as string;
}

function num(row: Record<string, unknown>, column: string): number {
  return Number(row[column]);
}

function ts(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return value instanceof Date ? value.toISOString() : String(value);
}

function strOrUndef(row: Record<string, unknown>, column: string): string | undefined {
  return (row[column] as string | null) ?? undefined;
}

function numOrUndef(row: Record<string, unknown>, column: string): number | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : Number(value);
}

function strArray(row: Record<string, unknown>, column: string): string[] {
  const value = row[column];
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as string[];
  }
  return [];
}

/* ----------------------------- commodity lots ---------------------------- */

const LOT_COLS =
  'id, owner_user_id, crop, variety, harvest_window_start, harvest_window_end, quantity, unit, status, parent_lot_ids, created_at, updated_at';

function lotFromRow(row: Record<string, unknown>): CommodityLot {
  return {
    id: str(row, 'id'),
    ownerUserId: str(row, 'owner_user_id'),
    crop: str(row, 'crop'),
    variety: strOrUndef(row, 'variety'),
    harvestWindowStart: ts(row, 'harvest_window_start'),
    harvestWindowEnd: ts(row, 'harvest_window_end'),
    quantity: num(row, 'quantity'),
    unit: str(row, 'unit'),
    status: str(row, 'status') as CommodityLot['status'],
    parentLotIds: strArray(row, 'parent_lot_ids'),
    createdAt: ts(row, 'created_at'),
    updatedAt: ts(row, 'updated_at')
  };
}

export class PgCommodityLotRepository implements CommodityLotRepository {
  private static readonly TABLE = 'traceability.commodity_lots';

  constructor(private readonly pool: pg.Pool) {}

  async create(lot: CommodityLot): Promise<CommodityLot> {
    try {
      await this.pool.query(
        `INSERT INTO ${PgCommodityLotRepository.TABLE} (${LOT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          lot.id,
          lot.ownerUserId,
          lot.crop,
          lot.variety ?? null,
          lot.harvestWindowStart,
          lot.harvestWindowEnd,
          lot.quantity,
          lot.unit,
          lot.status,
          JSON.stringify(lot.parentLotIds),
          lot.createdAt,
          lot.updatedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return lot;
  }

  async findById(id: string): Promise<CommodityLot | undefined> {
    const result = await this.pool.query(
      `SELECT ${LOT_COLS} FROM ${PgCommodityLotRepository.TABLE} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? lotFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<CommodityLot> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Commodity lot '${id}' not found`);
    }
    return item;
  }

  async find(criteria: CommodityLotCriteria): Promise<CommodityLot[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (criteria.ownerUserId) {
      params.push(criteria.ownerUserId);
      parts.push(`owner_user_id = $${params.length}`);
    }
    if (criteria.crop) {
      params.push(criteria.crop);
      parts.push(`crop = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      parts.push(`status = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${LOT_COLS} FROM ${PgCommodityLotRepository.TABLE}${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map(lotFromRow);
  }

  async update(
    id: string,
    patch: Partial<Pick<CommodityLot, 'status' | 'quantity' | 'updatedAt'>>
  ): Promise<CommodityLot> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) {
      params.push(patch.status);
      sets.push(`status = $${params.length}`);
    }
    if (patch.quantity !== undefined) {
      params.push(patch.quantity);
      sets.push(`quantity = $${params.length}`);
    }
    if (patch.updatedAt !== undefined) {
      params.push(patch.updatedAt);
      sets.push(`updated_at = $${params.length}`);
    }
    if (sets.length === 0) {
      return this.getById(id);
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE ${PgCommodityLotRepository.TABLE} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${LOT_COLS}`,
      params
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Commodity lot '${id}' not found`);
    }
    return lotFromRow(result.rows[0]);
  }
}

export function createPgCommodityLotRepository(pool: pg.Pool): PgCommodityLotRepository {
  return new PgCommodityLotRepository(pool);
}

/* ----------------------------- custody events ---------------------------- */

const EVENT_COLS =
  'id, lot_id, seq, type, actor_id, occurred_at, latitude, longitude, h3_cell, quantity, unit, parent_lot_ids, note, prev_event_hash, event_hash, created_at';

function eventFromRow(row: Record<string, unknown>): CustodyEvent {
  return {
    id: str(row, 'id'),
    lotId: str(row, 'lot_id'),
    seq: num(row, 'seq'),
    type: str(row, 'type') as CustodyEvent['type'],
    actorId: str(row, 'actor_id'),
    occurredAt: ts(row, 'occurred_at'),
    latitude: num(row, 'latitude'),
    longitude: num(row, 'longitude'),
    h3Cell: strOrUndef(row, 'h3_cell'),
    quantity: numOrUndef(row, 'quantity'),
    unit: strOrUndef(row, 'unit'),
    parentLotIds: strArray(row, 'parent_lot_ids'),
    note: strOrUndef(row, 'note'),
    prevEventHash: str(row, 'prev_event_hash'),
    eventHash: str(row, 'event_hash'),
    createdAt: ts(row, 'created_at')
  };
}

export class PgCustodyEventRepository implements CustodyEventRepository {
  private static readonly TABLE = 'traceability.custody_events';

  constructor(private readonly pool: pg.Pool) {}

  async append(event: CustodyEvent): Promise<CustodyEvent> {
    try {
      await this.pool.query(
        `INSERT INTO ${PgCustodyEventRepository.TABLE} (${EVENT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          event.id,
          event.lotId,
          event.seq,
          event.type,
          event.actorId,
          event.occurredAt,
          event.latitude,
          event.longitude,
          event.h3Cell ?? null,
          event.quantity ?? null,
          event.unit ?? null,
          JSON.stringify(event.parentLotIds),
          event.note ?? null,
          event.prevEventHash,
          event.eventHash,
          event.createdAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return event;
  }

  async findById(id: string): Promise<CustodyEvent | undefined> {
    const result = await this.pool.query(
      `SELECT ${EVENT_COLS} FROM ${PgCustodyEventRepository.TABLE} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? eventFromRow(result.rows[0]) : undefined;
  }

  async find(criteria: CustodyEventCriteria): Promise<CustodyEvent[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (criteria.lotId) {
      params.push(criteria.lotId);
      parts.push(`lot_id = $${params.length}`);
    }
    if (criteria.type) {
      params.push(criteria.type);
      parts.push(`type = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${EVENT_COLS} FROM ${PgCustodyEventRepository.TABLE}${where} ORDER BY lot_id, seq`,
      params
    );
    return result.rows.map(eventFromRow);
  }

  async listByLot(lotId: string): Promise<CustodyEvent[]> {
    const result = await this.pool.query(
      `SELECT ${EVENT_COLS} FROM ${PgCustodyEventRepository.TABLE} WHERE lot_id = $1 ORDER BY seq`,
      [lotId]
    );
    return result.rows.map(eventFromRow);
  }

  async countByLot(lotId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM ${PgCustodyEventRepository.TABLE} WHERE lot_id = $1`,
      [lotId]
    );
    return Number(result.rows[0]?.n ?? 0);
  }
}

export function createPgCustodyEventRepository(pool: pg.Pool): PgCustodyEventRepository {
  return new PgCustodyEventRepository(pool);
}

/* ----------------------------- lot plot links ---------------------------- */

const LINK_COLS =
  'id, lot_id, plot_id, plot_owner_user_id, plot_name, latitude, longitude, h3_cell, linked_at, linked_by';

function linkFromRow(row: Record<string, unknown>): LotPlotLink {
  return {
    id: str(row, 'id'),
    lotId: str(row, 'lot_id'),
    plotId: str(row, 'plot_id'),
    plotOwnerUserId: str(row, 'plot_owner_user_id'),
    plotName: str(row, 'plot_name'),
    latitude: num(row, 'latitude'),
    longitude: num(row, 'longitude'),
    h3Cell: strOrUndef(row, 'h3_cell'),
    linkedAt: ts(row, 'linked_at'),
    linkedBy: str(row, 'linked_by')
  };
}

export class PgLotPlotLinkRepository implements LotPlotLinkRepository {
  private static readonly TABLE = 'traceability.lot_plot_links';

  constructor(private readonly pool: pg.Pool) {}

  async create(link: LotPlotLink): Promise<LotPlotLink> {
    try {
      await this.pool.query(
        `INSERT INTO ${PgLotPlotLinkRepository.TABLE} (${LINK_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          link.id,
          link.lotId,
          link.plotId,
          link.plotOwnerUserId,
          link.plotName,
          link.latitude,
          link.longitude,
          link.h3Cell ?? null,
          link.linkedAt,
          link.linkedBy
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return link;
  }

  async find(criteria: LotPlotLinkCriteria): Promise<LotPlotLink[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (criteria.lotId) {
      params.push(criteria.lotId);
      parts.push(`lot_id = $${params.length}`);
    }
    if (criteria.plotId) {
      params.push(criteria.plotId);
      parts.push(`plot_id = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${LINK_COLS} FROM ${PgLotPlotLinkRepository.TABLE}${where} ORDER BY linked_at, id`,
      params
    );
    return result.rows.map(linkFromRow);
  }
}

export function createPgLotPlotLinkRepository(pool: pg.Pool): PgLotPlotLinkRepository {
  return new PgLotPlotLinkRepository(pool);
}

/* ------------------------------- shipments ------------------------------- */

const SHIPMENT_COLS = 'id, creator_id, creator_kind, reference, status, created_at, updated_at';
const SHIPMENT_LOT_COLS = 'id, shipment_id, lot_id, position';

function shipmentFromRow(row: Record<string, unknown>): TraceabilityShipment {
  return {
    id: str(row, 'id'),
    creatorId: str(row, 'creator_id'),
    creatorKind: str(row, 'creator_kind') as TraceabilityShipment['creatorKind'],
    reference: strOrUndef(row, 'reference'),
    status: str(row, 'status') as TraceabilityShipment['status'],
    createdAt: ts(row, 'created_at'),
    updatedAt: ts(row, 'updated_at')
  };
}

function shipmentLotFromRow(row: Record<string, unknown>): ShipmentLot {
  return {
    id: str(row, 'id'),
    shipmentId: str(row, 'shipment_id'),
    lotId: str(row, 'lot_id'),
    position: num(row, 'position')
  };
}

export class PgTraceabilityShipmentRepository implements TraceabilityShipmentRepository {
  private static readonly TABLE = 'traceability.shipments';
  private static readonly LOT_TABLE = 'traceability.shipment_lots';

  constructor(private readonly pool: pg.Pool) {}

  async create(
    shipment: TraceabilityShipment,
    lots: readonly ShipmentLot[]
  ): Promise<TraceabilityShipment> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${PgTraceabilityShipmentRepository.TABLE} (${SHIPMENT_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          shipment.id,
          shipment.creatorId,
          shipment.creatorKind,
          shipment.reference ?? null,
          shipment.status,
          shipment.createdAt,
          shipment.updatedAt
        ]
      );
      for (const lot of lots) {
        await client.query(
          `INSERT INTO ${PgTraceabilityShipmentRepository.LOT_TABLE} (${SHIPMENT_LOT_COLS}) VALUES ($1,$2,$3,$4)`,
          [lot.id, lot.shipmentId, lot.lotId, lot.position]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      mapPgError(error);
    } finally {
      client.release();
    }
    return shipment;
  }

  async findById(id: string): Promise<TraceabilityShipment | undefined> {
    const result = await this.pool.query(
      `SELECT ${SHIPMENT_COLS} FROM ${PgTraceabilityShipmentRepository.TABLE} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? shipmentFromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<TraceabilityShipment> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Traceability shipment '${id}' not found`);
    }
    return item;
  }

  async find(criteria: TraceabilityShipmentCriteria): Promise<TraceabilityShipment[]> {
    const parts: string[] = [];
    const params: unknown[] = [];
    if (criteria.creatorId) {
      params.push(criteria.creatorId);
      parts.push(`creator_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      parts.push(`status = $${params.length}`);
    }
    const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${SHIPMENT_COLS} FROM ${PgTraceabilityShipmentRepository.TABLE}${where} ORDER BY created_at, id`,
      params
    );
    return result.rows.map(shipmentFromRow);
  }

  async listLots(shipmentId: string): Promise<ShipmentLot[]> {
    const result = await this.pool.query(
      `SELECT ${SHIPMENT_LOT_COLS} FROM ${PgTraceabilityShipmentRepository.LOT_TABLE} WHERE shipment_id = $1 ORDER BY position`,
      [shipmentId]
    );
    return result.rows.map(shipmentLotFromRow);
  }

  async updateStatus(
    id: string,
    status: TraceabilityShipment['status']
  ): Promise<TraceabilityShipment> {
    const result = await this.pool.query(
      `UPDATE ${PgTraceabilityShipmentRepository.TABLE} SET status = $1, updated_at = now() WHERE id = $2 RETURNING ${SHIPMENT_COLS}`,
      [status, id]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Traceability shipment '${id}' not found`);
    }
    return shipmentFromRow(result.rows[0]);
  }
}

export function createPgTraceabilityShipmentRepository(pool: pg.Pool): PgTraceabilityShipmentRepository {
  return new PgTraceabilityShipmentRepository(pool);
}
