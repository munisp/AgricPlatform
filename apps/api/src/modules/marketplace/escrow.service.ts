import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
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
 *
 * Provider-backed releases/refunds pass through the system-driven pending
 * states RELEASING/REFUNDING: the intent is persisted (guarded write) BEFORE
 * the provider call, so a crash mid-call is resumable and a retry converges
 * instead of double-releasing. Pending states are re-drivable by the party
 * that started them (and by admins/system paths).
 */
export const ESCROW_TRANSITIONS: Readonly<
  Record<EscrowStatus, Readonly<Partial<Record<EscrowStatus, readonly EscrowActor[]>>>>
> = {
  held: {
    released: ['buyer'],
    refunded: ['seller'],
    disputed: ['buyer', 'seller']
  },
  releasing: {
    // Retry/finalize of a provider-backed release (system-driven entry).
    released: ['buyer']
  },
  refunding: {
    // Retry/finalize of a provider-backed refund (system-driven entry).
    refunded: ['seller']
  },
  disputed: {
    // Dispute resolution is admin-mediated only (empty actor list).
    released: [],
    refunded: []
  },
  released: {},
  refunded: {}
};

/** System-driven pending states that API actors may never request directly. */
const PENDING_STATUSES: ReadonlySet<EscrowStatus> = new Set(['releasing', 'refunding']);

/** Default escrow hold lifetime before the deterministic auto-refund path. */
export const ESCROW_HOLD_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

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
    const heldAt = new Date();
    const record: EscrowRecord = {
      id: newId('escrow'),
      orderId,
      amountKobo,
      status: 'held',
      providerReference,
      heldAt: heldAt.toISOString(),
      heldUntil: new Date(heldAt.getTime() + ESCROW_HOLD_TTL_MS).toISOString()
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
    if (PENDING_STATUSES.has(status)) {
      throw new BadRequestException(
        `Status '${status}' is system-driven; request the terminal status instead`
      );
    }
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
    if (!record) {
      return record;
    }
    if (record.status === 'releasing') {
      return this.applyTransition(record, 'released', actorId); // resume a stuck release
    }
    if (record.status !== 'held') {
      return record; // nothing held, or awaiting dispute resolution
    }
    return this.applyTransition(record, 'released', actorId);
  }

  /** System-path dispute freeze when the underlying order is disputed. */
  async disputeForOrder(orderId: string, actorId: string): Promise<EscrowRecord | undefined> {
    const record = await this.escrowForOrder(orderId);
    if (!record || record.status !== 'held') {
      return record;
    }
    return this.applyTransition(record, 'disputed', actorId);
  }

  /** System-path refund (order cancellation). Held escrows only. */
  async refundForOrder(orderId: string, actorId: string): Promise<EscrowRecord | undefined> {
    const record = await this.escrowForOrder(orderId);
    if (!record) {
      return record;
    }
    if (record.status === 'refunding') {
      return this.applyTransition(record, 'refunded', actorId); // resume a stuck refund
    }
    if (record.status !== 'held') {
      return record;
    }
    return this.applyTransition(record, 'refunded', actorId);
  }

  /**
   * Deterministic expiry (funds-integrity wave): every held escrow whose
   * heldUntil deadline has passed is refunded through the same guarded
   * transition machinery. Safe to run repeatedly and concurrently — each
   * record moves exactly once; races against manual transitions surface as
   * conflicts and are skipped (the other transition already won).
   */
  async expireHeldEscrows(now: string = new Date().toISOString()): Promise<EscrowRecord[]> {
    const held = await this.escrows.find({ status: 'held' });
    const expired: EscrowRecord[] = [];
    for (const record of held) {
      if (!record.heldUntil || record.heldUntil > now) {
        continue;
      }
      try {
        expired.push(await this.applyTransition(record, 'refunded', 'system'));
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }
        // A concurrent transition won; the record is no longer held.
      }
    }
    return expired;
  }

  private async applyTransition(
    record: EscrowRecord,
    status: EscrowStatus,
    actorId: string
  ): Promise<EscrowRecord> {
    let current = record;
    const providerBacked =
      (status === 'released' || status === 'refunded') && record.providerReference && this.provider;
    if (providerBacked) {
      const pending: EscrowStatus = status === 'released' ? 'releasing' : 'refunding';
      if (record.status !== pending) {
        // Persist the intent FIRST (guarded): after this write a crash can
        // only leave a resumable pending record, never an unrecorded payout.
        current = await this.persistTransition(record, pending, actorId);
      }
      try {
        if (status === 'released') {
          await this.provider!.release(record.providerReference!);
        } else {
          await this.provider!.refund(record.providerReference!);
        }
      } catch (error) {
        await this.audit?.record({
          actorId,
          action: `marketplace.escrow.provider_failed`,
          entityType: 'escrow_record',
          entityId: record.id,
          metadata: {
            orderId: record.orderId,
            pendingStatus: pending,
            targetStatus: status,
            provider: this.provider!.name,
            error: error instanceof Error ? error.message : String(error)
          }
        });
        // The record stays in the pending state: retrying the same
        // transition resumes here and converges (the provider call carries
        // the same idempotent providerReference).
        throw new BadGatewayException(
          `Payment provider '${this.provider!.name}' failed to ${status === 'released' ? 'release' : 'refund'} ` +
            `escrow ${record.id}; the escrow is '${pending}' and the transition must be retried`
        );
      }
    }
    return this.persistTransition(current, status, actorId);
  }

  /**
   * Guarded state write + outbox event. The conditional update
   * (UPDATE … WHERE id AND status = :from) defeats concurrent-transition
   * races: the loser gets a 409 instead of silently overwriting. On
   * PostgreSQL the outbox event commits in the same transaction as the
   * state change (transactionalOutbox); in-memory repos persist the event
   * right after the synchronous check-and-set.
   */
  private async persistTransition(
    record: EscrowRecord,
    status: EscrowStatus,
    actorId: string
  ): Promise<EscrowRecord> {
    const terminal = status === 'released' || status === 'refunded';
    const event = this.events.build(
      'marketplace.escrow.status_changed',
      { escrowId: record.id, orderId: record.orderId, from: record.status, to: status },
      actorId
    );
    const updated = await this.escrows.updateExpected(
      record.id,
      { status, resolvedAt: terminal ? new Date().toISOString() : undefined },
      { status: record.status },
      event
    );
    if (this.escrows.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId,
      action: `marketplace.escrow.${status}`,
      entityType: 'escrow_record',
      entityId: record.id,
      metadata: { orderId: record.orderId, from: record.status, to: status, amountKobo: record.amountKobo }
    });
    return updated;
  }
}
