import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  COMMODITY_LOT_REPOSITORY,
  CUSTODY_EVENT_REPOSITORY,
  LOT_PLOT_LINK_REPOSITORY,
  TRACEABILITY_SHIPMENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  CommodityLotRepository,
  CustodyEventRepository,
  LotPlotLinkRepository,
  TraceabilityShipmentRepository
} from '../../database/repositories/traceability.repository.js';
import type { FarmsService } from '../farms/farms.service.js';
import type { GeoIntelService } from '../geo-intel/geo-intel.service.js';
import {
  computeEventHash,
  GENESIS_PREV_HASH,
  hashPayloadOf,
  verifyLotChain,
  type ChainVerification,
  type CommodityLot,
  type CustodyEvent,
  type CustodyEventType,
  type LotPlotLink,
  type ShipmentLot,
  type TraceabilityShipment
} from './traceability.types.js';

/**
 * Roles that may act as custody aggregators (cooperative / off-taker
 * hand-offs) on lots they do not own. Ownership of the lot itself never
 * transfers through these roles — they can only append custody events and
 * read lots where they already appear in the custody trail. Reuses the
 * existing platform role model (no new role introduced).
 */
export const AGGREGATOR_ROLES = ['buyer', 'supplier', 'partner', 'chapter_lead'] as const;

export interface CreateLotInput {
  crop: string;
  variety?: string;
  harvestWindowStart: string;
  harvestWindowEnd: string;
  quantity: number;
  unit: string;
}

export interface AddCustodyEventInput {
  type: CustodyEventType;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  quantity?: number;
  unit?: string;
  note?: string;
}

export interface LinkPlotInput {
  plotId: string;
}

export interface SplitLotInput {
  quantity: number;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  note?: string;
}

export interface AggregateLotsInput {
  parentLotIds: string[];
  crop: string;
  quantity: number;
  unit: string;
  occurredAt: string;
  latitude: number;
  longitude: number;
  h3Cell?: string;
  note?: string;
}

export interface CreateShipmentInput {
  lotIds: string[];
  reference?: string;
}

export interface DdsOperatorBlock {
  status: 'TO_BE_COMPLETED_BY_EXPORTER';
  legalName: string | null;
  eori: string | null;
  address: string | null;
  note: string;
}

export interface DdsPlotRisk {
  plotId: string;
  basis: 'live' | 'stub' | 'unavailable';
  floodDetected?: boolean;
  severity?: string;
  source?: string;
  detail?: string;
}

export interface EudrDds {
  statementVersion: '1.0';
  generatedAt: string;
  ddsReference: string;
  operator: DdsOperatorBlock;
  commodity: { description: string; crops: string[] };
  quantity: { value: number; unit: string };
  countryOfProduction: 'NG';
  productionPlots: Array<{
    plotId: string;
    lotId: string;
    latitude: number;
    longitude: number;
    h3Cell?: string;
    snapshotAt: string;
  }>;
  harvestWindow: { start: string; end: string };
  custodySummary: {
    lotCount: number;
    eventCount: number;
    firstEventAt?: string;
    lastEventAt?: string;
    eventTypes: string[];
  };
  deforestationRisk: {
    basis: 'live' | 'stub' | 'unavailable' | 'none';
    note: string;
    assessments: DdsPlotRisk[];
  };
  chainIntegrity: {
    verified: boolean;
    eventCount: number;
    lots: Array<{ lotId: string; valid: boolean; eventCount: number; headHash?: string }>;
    verifiedAt: string;
  };
  disclaimers: string[];
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for traceability records');
  }
  return actor;
}

function isAdmin(actor: User): boolean {
  return actor.roles.includes('admin');
}

function isAggregator(actor: User): boolean {
  return actor.roles.some((role) => (AGGREGATOR_ROLES as readonly string[]).includes(role));
}

function assertCoordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new BadRequestException('latitude must be a finite number between -90 and 90');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new BadRequestException('longitude must be a finite number between -180 and 180');
  }
}

/**
 * EUDR traceability passport service (wave-eudr): commodity lots, the
 * append-only custody hash chain, immutable plot-geometry snapshots,
 * shipments and the due-diligence statement (DDS) export. Geo risk inputs
 * come through the geo-intel port and are labelled honestly ('stub' when the
 * default simulated driver answers, 'unavailable' when a live driver is
 * configured but down) — never silently fabricated.
 */
@Injectable()
export class TraceabilityService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(COMMODITY_LOT_REPOSITORY) private readonly lots: CommodityLotRepository,
    @Inject(CUSTODY_EVENT_REPOSITORY) private readonly custodyEvents: CustodyEventRepository,
    @Inject(LOT_PLOT_LINK_REPOSITORY) private readonly plotLinks: LotPlotLinkRepository,
    @Inject(TRACEABILITY_SHIPMENT_REPOSITORY)
    private readonly shipments: TraceabilityShipmentRepository,
    @Optional() private readonly farms?: FarmsService,
    @Optional() private readonly geoIntel?: GeoIntelService
  ) {}

  /* --------------------------- authorisation --------------------------- */

  /** Read access: owner, admin, or an aggregator already in the custody trail. */
  private async assertLotReadAccess(actor: User, lot: CommodityLot): Promise<void> {
    if (actor.id === lot.ownerUserId || isAdmin(actor)) {
      return;
    }
    if (isAggregator(actor)) {
      const trail = await this.custodyEvents.listByLot(lot.id);
      if (trail.some((event) => event.actorId === actor.id)) {
        return;
      }
    }
    throw new ForbiddenException('You may only access lots you own or hold custody of');
  }

  /**
   * Event write access: the owner and admins may record any event;
   * aggregator roles may append custody events as themselves (chain-of-
   * custody hand-off). The recorded actorId is ALWAYS the caller — events
   * cannot be recorded on behalf of someone else.
   */
  private assertLotEventAccess(actor: User, lot: CommodityLot): void {
    if (actor.id === lot.ownerUserId || isAdmin(actor) || isAggregator(actor)) {
      return;
    }
    throw new ForbiddenException('You may only record custody on lots you own or aggregate');
  }

  /* --------------------------------- lots ------------------------------ */

  async createLot(actor: User | null, input: CreateLotInput): Promise<CommodityLot> {
    const caller = requireActor(actor);
    this.assertCreateLotInput(input);
    const now = new Date().toISOString();
    const lot: CommodityLot = {
      id: newId('lot'),
      ownerUserId: caller.id,
      crop: input.crop.trim(),
      variety: input.variety?.trim() || undefined,
      harvestWindowStart: input.harvestWindowStart,
      harvestWindowEnd: input.harvestWindowEnd,
      quantity: input.quantity,
      unit: input.unit.trim(),
      status: 'active',
      parentLotIds: [],
      createdAt: now,
      updatedAt: now
    };
    await this.lots.create(lot);
    await this.audit.record({
      actorId: caller.id,
      action: 'traceability.lot_created',
      entityType: 'commodity_lot',
      entityId: lot.id,
      metadata: { crop: lot.crop, quantity: lot.quantity, unit: lot.unit }
    });
    await this.events.publish(
      'traceability.lot.created',
      { lotId: lot.id, crop: lot.crop, quantity: lot.quantity, unit: lot.unit },
      caller.id
    );
    return lot;
  }

  private assertCreateLotInput(input: CreateLotInput): void {
    if (typeof input.crop !== 'string' || input.crop.trim().length === 0) {
      throw new BadRequestException('crop must be a non-empty string');
    }
    if (typeof input.unit !== 'string' || input.unit.trim().length === 0) {
      throw new BadRequestException('unit must be a non-empty string');
    }
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    const start = Date.parse(input.harvestWindowStart);
    const end = Date.parse(input.harvestWindowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new BadRequestException('harvestWindowStart/harvestWindowEnd must be ISO dates');
    }
    if (end < start) {
      throw new BadRequestException('harvestWindowEnd must not precede harvestWindowStart');
    }
  }

  async listLots(actor: User | null, ownerUserId?: string): Promise<CommodityLot[]> {
    const caller = requireActor(actor);
    if (isAdmin(caller)) {
      return this.lots.find(ownerUserId ? { ownerUserId } : {});
    }
    if (ownerUserId && ownerUserId !== caller.id) {
      throw new ForbiddenException('You may only list your own lots');
    }
    // Non-admins only ever see their own lots (custody-holding aggregators
    // read other lots by id through the custody-trail rule, never by list).
    return this.lots.find({ ownerUserId: caller.id });
  }

  async getLot(actor: User | null, lotId: string): Promise<CommodityLot> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    await this.assertLotReadAccess(caller, lot);
    return lot;
  }

  /* ---------------------------- custody chain -------------------------- */

  /**
   * Appends a custody event: seq = current chain length, prev = head hash
   * (genesis for the first event), then sha256 over the canonical payload.
   * CREATED events are restricted to the owner (a lot is born once).
   */
  async addCustodyEvent(
    actor: User | null,
    lotId: string,
    input: AddCustodyEventInput
  ): Promise<CustodyEvent> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    this.assertLotEventAccess(caller, lot);
    if (input.type === 'CREATED' && caller.id !== lot.ownerUserId && !isAdmin(caller)) {
      throw new ForbiddenException('Only the lot owner may record the CREATED event');
    }
    assertCoordinates(input.latitude, input.longitude);
    if (!Number.isFinite(Date.parse(input.occurredAt))) {
      throw new BadRequestException('occurredAt must be an ISO timestamp');
    }
    if (input.quantity !== undefined && (!Number.isFinite(input.quantity) || input.quantity <= 0)) {
      throw new BadRequestException('quantity must be a positive number when present');
    }

    const event = await this.buildAndAppendEvent(lot, caller.id, {
      type: input.type,
      occurredAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      h3Cell: input.h3Cell,
      quantity: input.quantity,
      unit: input.unit,
      parentLotIds: [],
      note: input.note
    });

    if (input.type === 'SHIPPED' && lot.status === 'active') {
      await this.lots.update(lot.id, { status: 'shipped', updatedAt: new Date().toISOString() });
    } else if (input.type === 'RECEIVED') {
      await this.lots.update(lot.id, { status: 'received', updatedAt: new Date().toISOString() });
    }

    await this.audit.record({
      actorId: caller.id,
      action: 'traceability.custody_recorded',
      entityType: 'custody_event',
      entityId: event.id,
      metadata: { lotId, type: event.type, seq: event.seq, eventHash: event.eventHash }
    });
    await this.events.publish(
      'traceability.custody.recorded',
      {
        eventId: event.id,
        lotId,
        type: event.type,
        seq: event.seq,
        eventHash: event.eventHash,
        prevEventHash: event.prevEventHash
      },
      caller.id
    );
    return event;
  }

  /** Shared append path used by plain events, splits and aggregations. */
  private async buildAndAppendEvent(
    lot: CommodityLot,
    actorId: string,
    fields: {
      type: CustodyEventType;
      occurredAt: string;
      latitude: number;
      longitude: number;
      h3Cell?: string;
      quantity?: number;
      unit?: string;
      parentLotIds: string[];
      note?: string;
    }
  ): Promise<CustodyEvent> {
    const seq = await this.custodyEvents.countByLot(lot.id);
    const trail = seq > 0 ? await this.custodyEvents.listByLot(lot.id) : [];
    const prevEventHash = seq > 0 ? trail[trail.length - 1].eventHash : GENESIS_PREV_HASH;
    const now = new Date().toISOString();
    const unsigned = {
      lotId: lot.id,
      seq,
      type: fields.type,
      actorId,
      occurredAt: fields.occurredAt,
      latitude: fields.latitude,
      longitude: fields.longitude,
      h3Cell: fields.h3Cell,
      quantity: fields.quantity,
      unit: fields.unit,
      parentLotIds: [...new Set(fields.parentLotIds)].sort(),
      note: fields.note,
      prevEventHash
    };
    const event: CustodyEvent = {
      id: newId('evt'),
      ...unsigned,
      eventHash: computeEventHash(hashPayloadOf(unsigned)),
      createdAt: now
    };
    return this.custodyEvents.append(event);
  }

  async timeline(
    actor: User | null,
    lotId: string
  ): Promise<{ lot: CommodityLot; events: CustodyEvent[]; verification: ChainVerification }> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    await this.assertLotReadAccess(caller, lot);
    const events = await this.custodyEvents.listByLot(lotId);
    return { lot, events, verification: verifyLotChain(lotId, events) };
  }

  /**
   * SPLIT: carves `quantity` off the parent lot into a new child lot. The
   * parent keeps a SPLIT event and the child is born with a CREATED event
   * whose payload references the parent — genealogy is preserved on both
   * sides and the parent's remaining quantity shrinks accordingly.
   */
  async splitLot(
    actor: User | null,
    lotId: string,
    input: SplitLotInput
  ): Promise<{ parent: CommodityLot; child: CommodityLot }> {
    const caller = requireActor(actor);
    const parent = await this.lots.getById(lotId);
    this.assertLotEventAccess(caller, parent);
    assertCoordinates(input.latitude, input.longitude);
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    if (input.quantity >= parent.quantity) {
      throw new BadRequestException('split quantity must be smaller than the lot quantity');
    }
    const now = new Date().toISOString();
    const child: CommodityLot = {
      id: newId('lot'),
      ownerUserId: parent.ownerUserId,
      crop: parent.crop,
      variety: parent.variety,
      harvestWindowStart: parent.harvestWindowStart,
      harvestWindowEnd: parent.harvestWindowEnd,
      quantity: input.quantity,
      unit: parent.unit,
      status: 'active',
      parentLotIds: [parent.id],
      createdAt: now,
      updatedAt: now
    };
    await this.lots.create(child);
    // Copy the parent's plot snapshots onto the child (same evidence).
    const links = await this.plotLinks.find({ lotId: parent.id });
    for (const link of links) {
      await this.plotLinks.create({
        ...link,
        id: newId('lpl'),
        lotId: child.id,
        linkedAt: now,
        linkedBy: caller.id
      });
    }
    await this.buildAndAppendEvent(parent, caller.id, {
      type: 'SPLIT',
      occurredAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      h3Cell: input.h3Cell,
      quantity: input.quantity,
      unit: parent.unit,
      parentLotIds: [child.id],
      note: input.note ?? `Split off child lot ${child.id}`
    });
    await this.buildAndAppendEvent(child, caller.id, {
      type: 'CREATED',
      occurredAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      h3Cell: input.h3Cell,
      quantity: input.quantity,
      unit: parent.unit,
      parentLotIds: [parent.id],
      note: input.note ?? `Split from parent lot ${parent.id}`
    });
    const updatedParent = await this.lots.update(parent.id, {
      quantity: parent.quantity - input.quantity,
      status: 'split',
      updatedAt: now
    });
    await this.events.publish(
      'traceability.lot.split',
      { parentLotId: parent.id, childLotId: child.id, quantity: input.quantity, unit: parent.unit },
      caller.id
    );
    return { parent: updatedParent, child };
  }

  /**
   * AGGREGATE: combines several parent lots into one child lot (many parents
   * allowed). Every parent gets marked 'aggregated'; the child is born with
   * an AGGREGATED event listing every parent and inherits the union of the
   * parents' plot snapshots.
   */
  async aggregateLots(
    actor: User | null,
    input: AggregateLotsInput
  ): Promise<CommodityLot> {
    const caller = requireActor(actor);
    const parentIds = [...new Set(input.parentLotIds)];
    if (parentIds.length < 2) {
      throw new BadRequestException('aggregation requires at least two parent lots');
    }
    assertCoordinates(input.latitude, input.longitude);
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive number');
    }
    const parents: CommodityLot[] = [];
    for (const parentId of parentIds) {
      const parent = await this.lots.getById(parentId);
      this.assertLotEventAccess(caller, parent);
      if (parent.status !== 'active' && parent.status !== 'received') {
        throw new BadRequestException(
          `Lot '${parentId}' cannot be aggregated from status '${parent.status}'`
        );
      }
      parents.push(parent);
    }
    const now = new Date().toISOString();
    const child: CommodityLot = {
      id: newId('lot'),
      ownerUserId: caller.id,
      crop: input.crop.trim(),
      harvestWindowStart: parents
        .map((parent) => parent.harvestWindowStart)
        .sort()[0],
      harvestWindowEnd: parents.map((parent) => parent.harvestWindowEnd).sort().slice(-1)[0],
      quantity: input.quantity,
      unit: input.unit.trim(),
      status: 'active',
      parentLotIds: parentIds,
      createdAt: now,
      updatedAt: now
    };
    await this.lots.create(child);
    // Inherit the union of parent plot snapshots (deduped by plot id).
    const seenPlots = new Set<string>();
    for (const parent of parents) {
      const links = await this.plotLinks.find({ lotId: parent.id });
      for (const link of links) {
        if (seenPlots.has(link.plotId)) {
          continue;
        }
        seenPlots.add(link.plotId);
        await this.plotLinks.create({
          ...link,
          id: newId('lpl'),
          lotId: child.id,
          linkedAt: now,
          linkedBy: caller.id
        });
      }
      await this.lots.update(parent.id, { status: 'aggregated', updatedAt: now });
    }
    await this.buildAndAppendEvent(child, caller.id, {
      type: 'AGGREGATED',
      occurredAt: input.occurredAt,
      latitude: input.latitude,
      longitude: input.longitude,
      h3Cell: input.h3Cell,
      quantity: input.quantity,
      unit: input.unit.trim(),
      parentLotIds: parentIds,
      note: input.note
    });
    await this.events.publish(
      'traceability.lot.aggregated',
      { childLotId: child.id, parentLotIds: parentIds, quantity: child.quantity, unit: child.unit },
      caller.id
    );
    return child;
  }

  /* --------------------------- plot snapshots -------------------------- */

  /**
   * Links a production plot to a lot by COPYING its geometry (lat/long +
   * H3 res-7 cell) into an immutable snapshot. The snapshot is the EUDR
   * Annex II geolocation evidence: later edits to the live plot row never
   * rewrite it. Plot access goes through FarmsService.getPlot (owner/admin)
   * — you can only attach plots you are entitled to see.
   */
  async linkPlot(actor: User | null, lotId: string, input: LinkPlotInput): Promise<LotPlotLink> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    if (caller.id !== lot.ownerUserId && !isAdmin(caller)) {
      throw new ForbiddenException('Only the lot owner may attach production plots');
    }
    if (!this.farms) {
      throw new BadRequestException('Farm plot service is not available in this deployment');
    }
    const plot = await this.farms.getPlot(caller, input.plotId);
    const existing = await this.plotLinks.find({ lotId, plotId: plot.id });
    if (existing.length > 0) {
      throw new BadRequestException(`Plot '${plot.id}' is already linked to lot '${lotId}'`);
    }
    const link: LotPlotLink = {
      id: newId('lpl'),
      lotId,
      plotId: plot.id,
      plotOwnerUserId: plot.ownerUserId,
      plotName: plot.name,
      latitude: plot.centroidLat,
      longitude: plot.centroidLong,
      linkedAt: new Date().toISOString(),
      linkedBy: caller.id
    };
    await this.plotLinks.create(link);
    await this.events.publish(
      'traceability.plot.linked',
      { lotId, plotId: plot.id, latitude: link.latitude, longitude: link.longitude },
      caller.id
    );
    return link;
  }

  async listPlotLinks(actor: User | null, lotId: string): Promise<LotPlotLink[]> {
    const caller = requireActor(actor);
    const lot = await this.lots.getById(lotId);
    await this.assertLotReadAccess(caller, lot);
    return this.plotLinks.find({ lotId });
  }

  /* ------------------------------ shipments ---------------------------- */

  private async buildShipment(
    creatorId: string,
    creatorKind: 'user' | 'partner',
    input: CreateShipmentInput
  ): Promise<{ shipment: TraceabilityShipment; lots: CommodityLot[] }> {
    const lotIds = [...new Set(input.lotIds)];
    if (lotIds.length === 0) {
      throw new BadRequestException('A shipment requires at least one lot');
    }
    const lots: CommodityLot[] = [];
    for (const lotId of lotIds) {
      lots.push(await this.lots.getById(lotId));
    }
    const now = new Date().toISOString();
    const shipment: TraceabilityShipment = {
      id: newId('tsh'),
      creatorId,
      creatorKind,
      reference: input.reference?.trim() || undefined,
      status: 'created',
      createdAt: now,
      updatedAt: now
    };
    const shipmentLots: ShipmentLot[] = lotIds.map((lotId, index) => ({
      id: newId('tsl'),
      shipmentId: shipment.id,
      lotId,
      position: index
    }));
    await this.shipments.create(shipment, shipmentLots);
    return { shipment, lots };
  }

  async createShipment(
    actor: User | null,
    input: CreateShipmentInput
  ): Promise<{ shipment: TraceabilityShipment; lots: CommodityLot[] }> {
    const caller = requireActor(actor);
    // Users may only ship lots they can read (own / custody / admin).
    for (const lotId of [...new Set(input.lotIds)]) {
      const lot = await this.lots.getById(lotId);
      await this.assertLotReadAccess(caller, lot);
    }
    const result = await this.buildShipment(caller.id, 'user', input);
    await this.audit.record({
      actorId: caller.id,
      action: 'traceability.shipment_created',
      entityType: 'traceability_shipment',
      entityId: result.shipment.id,
      metadata: { lotIds: [...new Set(input.lotIds)] }
    });
    await this.events.publish(
      'traceability.shipment.created',
      { shipmentId: result.shipment.id, lotIds: [...new Set(input.lotIds)], creatorKind: 'user' },
      caller.id
    );
    return result;
  }

  /**
   * Partner/exporter shipment creation (API-key / client-credentials
   * surface). The creator is the partner client id; lot existence is
   * enforced, ownership checks are scope-based (traceability:write) because
   * exporters act across many farmers' lots under contract.
   */
  async createShipmentForPartner(
    clientId: string,
    input: CreateShipmentInput
  ): Promise<{ shipment: TraceabilityShipment; lots: CommodityLot[] }> {
    const result = await this.buildShipment(`partner:${clientId}`, 'partner', input);
    await this.events.publish(
      'traceability.shipment.created',
      {
        shipmentId: result.shipment.id,
        lotIds: [...new Set(input.lotIds)],
        creatorKind: 'partner'
      },
      undefined
    );
    return result;
  }

  async getShipment(
    actor: User | null,
    shipmentId: string
  ): Promise<{ shipment: TraceabilityShipment; lots: CommodityLot[] }> {
    const caller = requireActor(actor);
    const shipment = await this.shipments.getById(shipmentId);
    if (shipment.creatorId !== caller.id && !isAdmin(caller)) {
      // A non-creator may read the shipment only if they can read every lot.
      const lots = await this.shipmentLots(shipmentId);
      for (const lot of lots) {
        await this.assertLotReadAccess(caller, lot);
      }
      return { shipment, lots };
    }
    return { shipment, lots: await this.shipmentLots(shipmentId) };
  }

  async listShipments(actor: User | null): Promise<TraceabilityShipment[]> {
    const caller = requireActor(actor);
    if (isAdmin(caller)) {
      return this.shipments.find({});
    }
    return this.shipments.find({ creatorId: caller.id });
  }

  private async shipmentLots(shipmentId: string): Promise<CommodityLot[]> {
    const links = await this.shipments.listLots(shipmentId);
    const lots: CommodityLot[] = [];
    for (const link of links) {
      lots.push(await this.lots.getById(link.lotId));
    }
    return lots;
  }

  /* ------------------------------- DDS export -------------------------- */

  /**
   * Builds the EUDR-aligned due-diligence statement JSON for a shipment.
   * The operator block is an explicit placeholder (legal submission requires
   * the exporter's registered operator identity + EORI — an external gate);
   * deforestation-risk inputs go through the geo-intel port with an honest
   * basis label; the chain-integrity block recomputes every hash.
   */
  async exportDds(actor: User | null, shipmentId: string): Promise<EudrDds> {
    const caller = requireActor(actor);
    await this.getShipment(caller, shipmentId);
    return this.buildDds(shipmentId, caller);
  }

  /** Partner-scoped DDS export (traceability:read). */
  async exportDdsForPartner(clientId: string, shipmentId: string): Promise<EudrDds> {
    const shipment = await this.shipments.getById(shipmentId);
    if (shipment.creatorId !== `partner:${clientId}`) {
      throw new ForbiddenException('Partners may only export DDS for their own shipments');
    }
    return this.buildDds(shipmentId, null);
  }

  private async buildDds(shipmentId: string, actor: User | null): Promise<EudrDds> {
    const shipment = await this.shipments.getById(shipmentId);
    const lots = await this.shipmentLots(shipmentId);

    const productionPlots: EudrDds['productionPlots'] = [];
    const custodyEventTypes = new Set<string>();
    let eventCount = 0;
    let firstEventAt: string | undefined;
    let lastEventAt: string | undefined;
    const lotIntegrity: EudrDds['chainIntegrity']['lots'] = [];

    for (const lot of lots) {
      const links = await this.plotLinks.find({ lotId: lot.id });
      for (const link of links) {
        productionPlots.push({
          plotId: link.plotId,
          lotId: lot.id,
          latitude: link.latitude,
          longitude: link.longitude,
          ...(link.h3Cell ? { h3Cell: link.h3Cell } : {}),
          snapshotAt: link.linkedAt
        });
      }
      const events = await this.custodyEvents.listByLot(lot.id);
      const verification = verifyLotChain(lot.id, events);
      lotIntegrity.push({
        lotId: lot.id,
        valid: verification.valid,
        eventCount: verification.eventCount,
        ...(events.length > 0 ? { headHash: events[events.length - 1].eventHash } : {})
      });
      eventCount += events.length;
      for (const event of events) {
        custodyEventTypes.add(event.type);
        if (!firstEventAt || event.occurredAt < firstEventAt) {
          firstEventAt = event.occurredAt;
        }
        if (!lastEventAt || event.occurredAt > lastEventAt) {
          lastEventAt = event.occurredAt;
        }
      }
    }

    const risk = await this.assessPlotRisks(actor, productionPlots);

    const totalQuantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const units = [...new Set(lots.map((lot) => lot.unit))];
    const dds: EudrDds = {
      statementVersion: '1.0',
      generatedAt: new Date().toISOString(),
      ddsReference: shipment.id,
      operator: {
        status: 'TO_BE_COMPLETED_BY_EXPORTER',
        legalName: null,
        eori: null,
        address: null,
        note:
          'Placeholder block: the exporting legal entity must complete operator name, EORI ' +
          'number and address before submission to the EU Information System. Legal DDS ' +
          'submission is an external gate outside this platform.'
      },
      commodity: {
        description: lots.map((lot) => lot.crop).join(', '),
        crops: [...new Set(lots.map((lot) => lot.crop))]
      },
      quantity: { value: totalQuantity, unit: units.length === 1 ? units[0] : 'mixed' },
      countryOfProduction: 'NG',
      productionPlots,
      harvestWindow: {
        start: lots.map((lot) => lot.harvestWindowStart).sort()[0] ?? '',
        end: lots.map((lot) => lot.harvestWindowEnd).sort().slice(-1)[0] ?? ''
      },
      custodySummary: {
        lotCount: lots.length,
        eventCount,
        ...(firstEventAt ? { firstEventAt } : {}),
        ...(lastEventAt ? { lastEventAt } : {}),
        eventTypes: [...custodyEventTypes].sort()
      },
      deforestationRisk: risk,
      chainIntegrity: {
        verified: lotIntegrity.every((lot) => lot.valid),
        eventCount,
        lots: lotIntegrity,
        verifiedAt: new Date().toISOString()
      },
      disclaimers: [
        'Operator block is a placeholder: the exporter legal entity must supply name, EORI and address; legal DDS submission to the EU Information System is an external gate not performed by this platform.',
        'Deforestation-risk inputs depend on the configured geo-intel providers; the default deployment uses a simulated stub and this statement says so in deforestationRisk.basis.',
        'Chain integrity is recomputed at export time from the append-only custody hash chain; a false verified flag means stored evidence failed recomputation and the shipment must not ship.',
        'No integration with the EU Information System has been performed or verified.'
      ]
    };
    await this.shipments.updateStatus(shipmentId, 'exported');
    await this.events.publish(
      'traceability.dds.exported',
      { shipmentId, lotCount: lots.length, eventCount, chainVerified: dds.chainIntegrity.verified },
      actor?.id
    );
    return dds;
  }

  /**
   * Risk inputs through the geo-intel port. basis is honest: 'live' when the
   * http driver answers, 'stub' for the default simulated fixture,
   * 'unavailable' when a configured live provider is down (fail-closed — we
   * never substitute the stub for a failed live call), 'none' when the
   * geo-intel module is absent.
   */
  private async assessPlotRisks(
    actor: User | null,
    plots: EudrDds['productionPlots']
  ): Promise<EudrDds['deforestationRisk']> {
    const note =
      'Environmental risk proxy inputs (flood/land-surface flags) from the geo-intel port; a dedicated deforestation feed is not integrated in this wave.';
    if (!this.geoIntel || plots.length === 0) {
      return { basis: 'none', note, assessments: [] };
    }
    const riskActor: User =
      actor ?? ({ id: 'system:traceability', roles: ['admin'] } as unknown as User);
    const assessments: DdsPlotRisk[] = [];
    let basis: 'live' | 'stub' | 'unavailable' = 'stub';
    const seen = new Set<string>();
    for (const plot of plots) {
      if (seen.has(plot.plotId)) {
        continue;
      }
      seen.add(plot.plotId);
      try {
        const result = await this.geoIntel.assessFloodRisk(riskActor, {
          lat: plot.latitude,
          long: plot.longitude
        });
        basis = result.driver === 'http' ? 'live' : 'stub';
        assessments.push({
          plotId: plot.plotId,
          basis,
          floodDetected: result.floodDetected,
          severity: result.severity,
          source: result.source
        });
      } catch {
        basis = 'unavailable';
        assessments.push({
          plotId: plot.plotId,
          basis: 'unavailable',
          detail: 'geo-intel provider configured but unreachable at export time'
        });
      }
    }
    return { basis, note, assessments };
  }

  /**
   * Recomputes the hash chain for every lot in a shipment and returns the
   * per-event validity — the tamper-evidence surface behind the verify UI.
   */
  async verifyShipmentChain(
    actor: User | null,
    shipmentId: string
  ): Promise<{ shipmentId: string; allValid: boolean; eventCount: number; lots: ChainVerification[] }> {
    const caller = requireActor(actor);
    await this.getShipment(caller, shipmentId);
    return this.verifyShipmentChainInternal(shipmentId);
  }

  /** Partner-scoped chain verification (traceability:read). */
  async verifyShipmentChainForPartner(
    clientId: string,
    shipmentId: string
  ): Promise<{ shipmentId: string; allValid: boolean; eventCount: number; lots: ChainVerification[] }> {
    const shipment = await this.shipments.getById(shipmentId);
    if (shipment.creatorId !== `partner:${clientId}`) {
      throw new ForbiddenException('Partners may only verify their own shipments');
    }
    return this.verifyShipmentChainInternal(shipmentId);
  }

  private async verifyShipmentChainInternal(
    shipmentId: string
  ): Promise<{ shipmentId: string; allValid: boolean; eventCount: number; lots: ChainVerification[] }> {
    const lots = await this.shipmentLots(shipmentId);
    const verifications: ChainVerification[] = [];
    let eventCount = 0;
    for (const lot of lots) {
      const events = await this.custodyEvents.listByLot(lot.id);
      eventCount += events.length;
      verifications.push(verifyLotChain(lot.id, events));
    }
    return {
      shipmentId,
      allValid: verifications.every((verification) => verification.valid),
      eventCount,
      lots: verifications
    };
  }
}
