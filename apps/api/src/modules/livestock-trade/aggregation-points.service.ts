import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable
} from '@nestjs/common';
import type { AggregationPoint, User } from '@agric-platform/shared';
import { NIGERIAN_STATE_CODES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGGREGATION_POINT_REPOSITORY,
  LOT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { LotRepository } from '../../database/repositories/livestock.repository.js';
import type { AggregationPointRepository } from '../../database/repositories/livestock-trade.repository.js';
import { assertRole, requireActor } from './trade.utils.js';

export interface CreateAggregationPointInput {
  name: string;
  state: string;
  lga: string;
  capacity?: number;
}

/**
 * Aggregation points (F7): partner-managed collection hubs. Lots assigned
 * to a point must share a single species, and the summed lot quantities
 * may not exceed the point capacity. Assignment publishes
 * livestock_trade.aggregation.lot_assigned for downstream logistics.
 */
@Injectable()
export class AggregationPointsService {
  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(AGGREGATION_POINT_REPOSITORY)
    private readonly points: AggregationPointRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository
  ) {}

  async create(actor: User | null, input: CreateAggregationPointInput): Promise<AggregationPoint> {
    const caller = assertRole(actor, ['partner']);
    if (!input.name.trim() || !input.lga.trim()) {
      throw new BadRequestException('Aggregation point name and lga are required');
    }
    if (!NIGERIAN_STATE_CODES[input.state]) {
      throw new BadRequestException(`Unknown Nigerian state '${input.state}'`);
    }
    if (input.capacity !== undefined && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
      throw new BadRequestException('capacity must be a positive integer');
    }
    const now = new Date().toISOString();
    const point: AggregationPoint = {
      id: newId('aggregation_point'),
      name: input.name,
      state: input.state,
      lga: input.lga,
      managerUserId: caller.id,
      capacity: input.capacity,
      lotIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.points.create(point);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.aggregation_point_created',
      entityType: 'aggregation_point',
      entityId: created.id,
      metadata: { name: created.name, state: created.state, lga: created.lga }
    });
    return created;
  }

  async list(actor: User | null, state?: string): Promise<AggregationPoint[]> {
    requireActor(actor);
    return this.points.find({ state, status: 'active' });
  }

  async listMine(actor: User | null): Promise<AggregationPoint[]> {
    const caller = requireActor(actor);
    return this.points.find({ managerUserId: caller.id });
  }

  async getById(actor: User | null, id: string): Promise<AggregationPoint> {
    requireActor(actor);
    return this.points.getById(id);
  }

  /** Assigns a lot to a point after species-consistency and capacity checks. */
  async assignLot(actor: User | null, pointId: string, lotId: string): Promise<AggregationPoint> {
    const caller = requireActor(actor);
    const point = await this.points.getById(pointId);
    assertSelfOrAdmin(caller, point.managerUserId);
    if (point.status !== 'active') {
      throw new BadRequestException(`Aggregation point '${pointId}' is ${point.status}`);
    }
    if (point.lotIds.includes(lotId)) {
      throw new ConflictException(`Lot '${lotId}' is already assigned to point '${pointId}'`);
    }
    const lot = await this.lots.getById(lotId);
    const assignedLots = await Promise.all(point.lotIds.map((id) => this.lots.getById(id)));
    const species = assignedLots[0]?.species;
    if (species && species !== lot.species) {
      throw new BadRequestException(
        `Aggregation point '${pointId}' holds ${species} lots; lot '${lotId}' is ${lot.species}`
      );
    }
    if (point.capacity !== undefined) {
      const headcount = assignedLots.reduce((sum, assigned) => sum + assigned.quantity, 0);
      if (headcount + lot.quantity > point.capacity) {
        throw new BadRequestException(
          `Assigning lot '${lotId}' (${lot.quantity} head) exceeds the capacity of point '${pointId}' (${point.capacity})`
        );
      }
    }
    const updated = await this.points.update(pointId, {
      lotIds: [...point.lotIds, lotId],
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.aggregation_lot_assigned',
      entityType: 'aggregation_point',
      entityId: pointId,
      metadata: { lotId, species: lot.species, quantity: lot.quantity }
    });
    // Downstream logistics integration point.
    await this.events.publish(
      'livestock_trade.aggregation.lot_assigned',
      { pointId, lotId, species: lot.species, quantity: lot.quantity, state: point.state },
      caller.id
    );
    return updated;
  }

  async unassignLot(actor: User | null, pointId: string, lotId: string): Promise<AggregationPoint> {
    const caller = requireActor(actor);
    const point = await this.points.getById(pointId);
    assertSelfOrAdmin(caller, point.managerUserId);
    if (!point.lotIds.includes(lotId)) {
      throw new BadRequestException(`Lot '${lotId}' is not assigned to point '${pointId}'`);
    }
    const updated = await this.points.update(pointId, {
      lotIds: point.lotIds.filter((id) => id !== lotId),
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_trade.aggregation_lot_unassigned',
      entityType: 'aggregation_point',
      entityId: pointId,
      metadata: { lotId }
    });
    return updated;
  }

  /** active → inactive (manager or admin); assignments stay recorded. */
  async deactivate(actor: User | null, pointId: string): Promise<AggregationPoint> {
    const caller = requireActor(actor);
    const point = await this.points.getById(pointId);
    assertSelfOrAdmin(caller, point.managerUserId);
    return this.points.update(pointId, {
      status: 'inactive',
      updatedAt: new Date().toISOString()
    });
  }
}
