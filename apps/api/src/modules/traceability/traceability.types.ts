import { createHash } from 'node:crypto';

/**
 * EUDR traceability passport domain types + the custody hash-chain scheme
 * (wave-eudr, migrations 029/030). The chain gives append-only integrity
 * WITHOUT database triggers: every custody event embeds the sha256 of its
 * canonical payload chained to the previous event's hash, so rewriting any
 * stored field breaks recomputation at that event and every descendant.
 */

export const CUSTODY_EVENT_TYPES = [
  'CREATED',
  'AGGREGATED',
  'SPLIT',
  'TRANSFORMED',
  'SHIPPED',
  'RECEIVED'
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export const LOT_STATUSES = ['active', 'aggregated', 'split', 'shipped', 'received'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

/** Genesis prev-hash: 64 zero hex chars (sha256-sized). */
export const GENESIS_PREV_HASH = '0'.repeat(64);

export interface CommodityLot {
  id: string;
  ownerUserId: string;
  crop: string;
  variety?: string;
  harvestWindowStart: string;
  harvestWindowEnd: string;
  quantity: number;
  unit: string;
  status: LotStatus;
  /** Genealogy: parents this lot was aggregated from / split from. */
  parentLotIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustodyEvent {
  id: string;
  lotId: string;
  /** Per-lot monotonic position (0-based); part of the chain ordering. */
  seq: number;
  type: CustodyEventType;
  actorId: string;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  quantity?: number;
  unit?: string;
  /** Genealogy carried on AGGREGATED/SPLIT events (sorted, unique). */
  parentLotIds: string[];
  note?: string;
  prevEventHash: string;
  eventHash: string;
  createdAt: string;
}

/**
 * Immutable geolocation evidence: a copy of the plot's coordinates at link
 * time (EUDR Annex II geolocation of production plots). Never updated.
 */
export interface LotPlotLink {
  id: string;
  lotId: string;
  plotId: string;
  plotOwnerUserId: string;
  plotName: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  linkedAt: string;
  linkedBy: string;
}

export type ShipmentStatus = 'created' | 'exported';
export type ShipmentCreatorKind = 'user' | 'partner';

export interface TraceabilityShipment {
  id: string;
  creatorId: string;
  creatorKind: ShipmentCreatorKind;
  reference?: string;
  status: ShipmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentLot {
  id: string;
  shipmentId: string;
  lotId: string;
  position: number;
}

/* ------------------------------------------------------------------------ */
/* Hash-chain scheme                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Canonical JSON: object keys sorted recursively, no insignificant
 * whitespace, undefined dropped, null kept explicit. Both the writer and the
 * verifier use this exact serialisation, and it is documented in
 * docs/eudr-traceability.md so external verifiers can recompute hashes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalise(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) {
        out[key] = canonicalise(item);
      }
    }
    return out;
  }
  return value;
}

/**
 * The exact payload the hash covers. Optional fields are normalised to null
 * (never omitted) so the canonical form is stable across writers. The event
 * id and createdAt are deliberately NOT hashed: they are storage metadata,
 * while the chain protects the custody facts.
 */
export interface CustodyHashPayload {
  actorId: string;
  h3Cell: string | null;
  latitude: number;
  longitude: number;
  lotId: string;
  note: string | null;
  occurredAt: string;
  parentLotIds: string[];
  prevEventHash: string;
  quantity: number | null;
  seq: number;
  type: CustodyEventType;
  unit: string | null;
}

export function hashPayloadOf(
  event: Pick<
    CustodyEvent,
    | 'actorId'
    | 'latitude'
    | 'longitude'
    | 'lotId'
    | 'occurredAt'
    | 'parentLotIds'
    | 'prevEventHash'
    | 'seq'
    | 'type'
  > &
    Partial<Pick<CustodyEvent, 'h3Cell' | 'note' | 'quantity' | 'unit'>>
): CustodyHashPayload {
  return {
    actorId: event.actorId,
    h3Cell: event.h3Cell ?? null,
    latitude: event.latitude,
    longitude: event.longitude,
    lotId: event.lotId,
    note: event.note ?? null,
    occurredAt: event.occurredAt,
    parentLotIds: [...event.parentLotIds].sort(),
    prevEventHash: event.prevEventHash,
    quantity: event.quantity ?? null,
    seq: event.seq,
    type: event.type,
    unit: event.unit ?? null
  };
}

/** sha256 hex over the canonical JSON of the hash payload. */
export function computeEventHash(payload: CustodyHashPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export interface EventVerification {
  eventId: string;
  lotId: string;
  seq: number;
  type: CustodyEventType;
  /** Recomputed hash equals the stored event_hash. */
  hashValid: boolean;
  /** Stored prev_event_hash equals the previous event's hash (or genesis). */
  prevLinkValid: boolean;
  valid: boolean;
  expectedHash: string;
  storedHash: string;
}

export interface ChainVerification {
  lotId: string;
  eventCount: number;
  valid: boolean;
  events: EventVerification[];
}

/**
 * Recomputes a lot's chain from the stored events (ascending seq). Detects
 * both payload tampering (hash mismatch) and chain surgery (prev-link
 * mismatch, seq gaps).
 */
export function verifyLotChain(lotId: string, events: readonly CustodyEvent[]): ChainVerification {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const results: EventVerification[] = [];
  let expectedPrev = GENESIS_PREV_HASH;
  let expectedSeq = 0;
  for (const event of ordered) {
    const expectedHash = computeEventHash(hashPayloadOf(event));
    const hashValid = expectedHash === event.eventHash;
    const prevLinkValid = event.prevEventHash === expectedPrev && event.seq === expectedSeq;
    results.push({
      eventId: event.id,
      lotId: event.lotId,
      seq: event.seq,
      type: event.type,
      hashValid,
      prevLinkValid,
      valid: hashValid && prevLinkValid,
      expectedHash,
      storedHash: event.eventHash
    });
    expectedPrev = event.eventHash;
    expectedSeq = event.seq + 1;
  }
  return {
    lotId,
    eventCount: ordered.length,
    valid: results.every((result) => result.valid),
    events: results
  };
}
