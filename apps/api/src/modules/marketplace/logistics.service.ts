import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type { Shipment, ShipmentStatus, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { ORDER_REPOSITORY, SHIPMENT_REPOSITORY } from '../../database/persistence.tokens.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type { ShipmentRepository } from '../../database/repositories/shipment.repository.js';
import { EscrowService } from './escrow.service.js';

type ShipmentActor = 'buyer' | 'seller';

/**
 * Shipment state machine: PICKUP_SCHEDULED → IN_TRANSIT → DELIVERED →
 * CONFIRMED, with FAILED from IN_TRANSIT and a reschedule path back to
 * PICKUP_SCHEDULED. CONFIRMED is terminal and releases the order escrow.
 */
export const SHIPMENT_TRANSITIONS: Readonly<
  Record<ShipmentStatus, Readonly<Partial<Record<ShipmentStatus, readonly ShipmentActor[]>>>>
> = {
  pickup_scheduled: {
    in_transit: ['seller']
  },
  in_transit: {
    delivered: ['seller'],
    failed: ['seller']
  },
  delivered: {
    confirmed: ['buyer']
  },
  failed: {
    pickup_scheduled: ['seller']
  },
  confirmed: {}
};

export interface SchedulePickupInput {
  carrier?: string;
  trackingReference?: string;
  scheduledPickupAt?: string;
}

@Injectable()
export class LogisticsService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(SHIPMENT_REPOSITORY) private readonly shipments: ShipmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly escrow: EscrowService,
    @Optional() private readonly audit?: AuditService
  ) {}

  async shipmentForOrder(orderId: string): Promise<Shipment | undefined> {
    return this.shipments.findOne({ orderId });
  }

  /**
   * Schedules pickup for an order. One shipment per order: a second call for
   * the same order is an idempotent replay returning the existing shipment.
   */
  async schedulePickup(
    orderId: string,
    input: SchedulePickupInput,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<Shipment> {
    const order = await this.orders.getById(orderId);
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin && actor.id !== order.sellerId) {
      throw new ForbiddenException('Only the order seller may schedule pickup');
    }
    if (order.status === 'cancelled' || order.status === 'requested' || order.status === 'negotiating') {
      throw new BadRequestException(
        `Cannot schedule shipment while the order is '${order.status}'`
      );
    }
    const existing = await this.shipmentForOrder(orderId);
    if (existing) {
      if (existing.status !== 'failed') {
        return existing; // idempotent replay
      }
      // Reschedule after a failed attempt.
      return this.applyTransition(existing, 'pickup_scheduled', actor.id, input);
    }
    const now = new Date().toISOString();
    const shipment: Shipment = {
      id: newId('shipment'),
      orderId,
      status: 'pickup_scheduled',
      carrier: input.carrier,
      trackingReference: input.trackingReference,
      scheduledPickupAt: input.scheduledPickupAt,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.shipments.create(shipment);
    await this.events.publish(
      'marketplace.shipment.scheduled',
      { shipmentId: created.id, orderId, carrier: created.carrier },
      actor.id
    );
    return created;
  }

  async transition(
    id: string,
    status: ShipmentStatus,
    actor: Pick<User, 'id' | 'roles'>,
    failureReason?: string
  ): Promise<Shipment> {
    const shipment = await this.shipments.getById(id);
    if (shipment.status === status) {
      return shipment; // idempotent replay
    }
    const allowed = SHIPMENT_TRANSITIONS[shipment.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid shipment transition '${shipment.status}' -> '${status}' for shipment ${id}`
      );
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const order = await this.orders.getById(shipment.orderId);
      const party: ShipmentActor | null =
        actor.id === order.buyerId ? 'buyer' : actor.id === order.sellerId ? 'seller' : null;
      if (!party || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the order ${allowed.join(' or ')} may move a shipment from '${shipment.status}' to '${status}'`
        );
      }
    }
    return this.applyTransition(shipment, status, actor.id, {
      failureReason: status === 'failed' ? (failureReason ?? 'unspecified') : undefined
    });
  }

  private async applyTransition(
    shipment: Shipment,
    status: ShipmentStatus,
    actorId: string,
    extra: { carrier?: string; trackingReference?: string; scheduledPickupAt?: string; failureReason?: string } = {}
  ): Promise<Shipment> {
    const now = new Date().toISOString();
    const updated = await this.shipments.update(shipment.id, {
      status,
      carrier: extra.carrier ?? shipment.carrier,
      trackingReference: extra.trackingReference ?? shipment.trackingReference,
      scheduledPickupAt: extra.scheduledPickupAt ?? shipment.scheduledPickupAt,
      pickedUpAt: status === 'in_transit' ? now : shipment.pickedUpAt,
      deliveredAt: status === 'delivered' ? now : shipment.deliveredAt,
      confirmedAt: status === 'confirmed' ? now : shipment.confirmedAt,
      failureReason:
        status === 'failed' ? extra.failureReason : status === 'pickup_scheduled' ? undefined : shipment.failureReason,
      updatedAt: now
    });
    // Delivery confirmation releases the order escrow (money movement: audited
    // inside EscrowService as well).
    if (status === 'confirmed') {
      await this.escrow.releaseForOrder(shipment.orderId, actorId);
      await this.audit?.record({
        actorId,
        action: 'marketplace.shipment.confirmed',
        entityType: 'shipment',
        entityId: shipment.id,
        metadata: { orderId: shipment.orderId }
      });
    }
    await this.events.publish(
      'marketplace.shipment.status_changed',
      { shipmentId: shipment.id, orderId: shipment.orderId, from: shipment.status, to: status },
      actorId
    );
    return updated;
  }
}
