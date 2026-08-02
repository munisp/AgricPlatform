import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional
} from '@nestjs/common';
import type { EscrowRecord, EscrowStatus, PaymentProviderPort, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { ESCROW_REPOSITORY, ORDER_REPOSITORY } from '../../database/persistence.tokens.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';

/**
 * Payment provider port token (wave P2a defines the port only). Paystack /
 * Flutterwave adapters register against this token in a later wave; without
 * a provider the escrow record still tracks state with no network calls.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/** Which order party may drive each escrow transition (admins may drive any). */
type EscrowActor = 'buyer' | 'seller';

/**
 * Escrow state machine: HELD → RELEASED | REFUNDED | DISPUTED, with
 * DISPUTED → RELEASED | REFUNDED as the admin-mediated resolution.
 * Terminal states accept no outbound transitions; re-sending the current
 * status is an idempotent no-op (same replay semantics as ORDER_TRANSITIONS).
 */
export const ESCROW_TRANSITIONS: Readonly<
  Record<EscrowStatus, Readonly<Partial<Record<EscrowStatus, readonly EscrowActor[]>>>>
> = {
  held: {
    released: ['buyer'],
    refunded: ['seller'],
    disputed: ['buyer', 'seller']
  },
  disputed: {
    // Dispute resolution is admin-mediated only (empty actor list).
    released: [],
    refunded: []
  },
  released: {},
  refunded: {}
};

@Injectable()
export class EscrowService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    @Optional() @Inject(PAYMENT_PROVIDER) private readonly provider?: PaymentProviderPort,
    @Optional() private readonly audit?: AuditService
  ) {}

  async escrowForOrder(orderId: string): Promise<EscrowRecord | undefined> {
    return this.escrows.findOne({ orderId });
  }

  /**
   * Places the order total (integer kobo) into escrow. Idempotent per order:
   * an existing escrow record is returned unchanged so webhook/order retries
   * never double-hold.
   */
  async holdForOrder(orderId: string, actorId: string): Promise<EscrowRecord> {
    const existing = await this.escrowForOrder(orderId);
    if (existing) {
      return existing;
    }
    const order = await this.orders.getById(orderId);
    if (order.status === 'cancelled') {
      throw new BadRequestException(`Cannot hold escrow for a cancelled order (${orderId})`);
    }
    const amountKobo = order.totalNaira * 100;
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
      throw new BadRequestException(`Order ${orderId} has no positive amount to escrow`);
    }
    let providerReference: string | undefined;
    if (this.provider) {
      const result = await this.provider.hold({
        orderId,
        amountKobo,
        currency: 'NGN',
        reference: `escrow:${orderId}`
      });
      providerReference = result.providerReference;
    }
    const record: EscrowRecord = {
      id: newId('escrow'),
      orderId,
      amountKobo,
      status: 'held',
      providerReference,
      heldAt: new Date().toISOString()
    };
    const created = await this.escrows.create(record);
    await this.audit?.record({
      actorId,
      action: 'marketplace.escrow.held',
      entityType: 'escrow_record',
      entityId: created.id,
      metadata: { orderId, amountKobo, provider: this.provider?.name ?? 'none' }
    });
    await this.events.publish(
      'marketplace.escrow.held',
      { escrowId: created.id, orderId, amountKobo },
      actorId
    );
    return created;
  }

  /**
   * Drives the escrow state machine with the same replay/actor rules as the
   * order state machine. Every transition is audit-logged (money movement).
   */
  async transition(
    id: string,
    status: EscrowStatus,
    actor: Pick<User, 'id' | 'roles'>
  ): Promise<EscrowRecord> {
    const record = await this.escrows.getById(id);
    if (record.status === status) {
      return record; // idempotent replay of a retry
    }
    const allowed = ESCROW_TRANSITIONS[record.status]?.[status];
    if (!allowed) {
      throw new BadRequestException(
        `Invalid escrow transition '${record.status}' -> '${status}' for escrow ${id}`
      );
    }
    const isAdmin = actor.roles.includes('admin');
    if (!isAdmin) {
      const order = await this.orders.getById(record.orderId);
      const party: EscrowActor | null =
        actor.id === order.buyerId ? 'buyer' : actor.id === order.sellerId ? 'seller' : null;
      if (!party || !allowed.includes(party)) {
        throw new ForbiddenException(
          `Only the order ${allowed.length > 0 ? allowed.join(' or ') : 'administrator'} may move escrow from '${record.status}' to '${status}'`
        );
      }
    }
    return this.applyTransition(record, status, actor.id);
  }

  /** System-path release (delivery confirmation, order completion). */
  async releaseForOrder(orderId: string, actorId: string): Promise<EscrowRecord | undefined> {
    const record = await this.escrowForOrder(orderId);
    if (!record || record.status !== 'held') {
      return record; // nothing held, or awaiting dispute resolution
    }
    return this.applyTransition(record, 'released', actorId);
  }

  /** System-path refund (order cancellation). Held escrows only. */
  async refundForOrder(orderId: string, actorId: string): Promise<EscrowRecord | undefined> {
    const record = await this.escrowForOrder(orderId);
    if (!record || record.status !== 'held') {
      return record;
    }
    return this.applyTransition(record, 'refunded', actorId);
  }

  private async applyTransition(
    record: EscrowRecord,
    status: EscrowStatus,
    actorId: string
  ): Promise<EscrowRecord> {
    if ((status === 'released' || status === 'refunded') && record.providerReference && this.provider) {
      if (status === 'released') {
        await this.provider.release(record.providerReference);
      } else {
        await this.provider.refund(record.providerReference);
      }
    }
    const terminal = status === 'released' || status === 'refunded';
    const updated = await this.escrows.update(record.id, {
      status,
      resolvedAt: terminal ? new Date().toISOString() : undefined
    });
    await this.audit?.record({
      actorId,
      action: `marketplace.escrow.${status}`,
      entityType: 'escrow_record',
      entityId: record.id,
      metadata: { orderId: record.orderId, from: record.status, to: status, amountKobo: record.amountKobo }
    });
    await this.events.publish(
      'marketplace.escrow.status_changed',
      { escrowId: record.id, orderId: record.orderId, from: record.status, to: status },
      actorId
    );
    return updated;
  }
}
