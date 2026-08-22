import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type { EscrowPayout, EscrowRecord, EscrowStatus, PaymentProviderPort, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ESCROW_PAYOUT_REPOSITORY,
  ESCROW_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import {
  claimPayoutAttempt,
  finalizePayoutAttempt,
  hashPayoutPayload,
  type EscrowPayoutRepository
} from '../../database/repositories/payout.repository.js';
import { ESCROW_PAYOUT_DRIVER, type EscrowPayoutDriverPort } from './payout.driver.js';

/**
 * Payment provider port token. Stage 22 (audit C2) registers the
 * Paystack/Flutterwave driver adapter against this token from
 * MarketplaceModule (see payment-provider.ts); without a provider the
 * escrow record still tracks state with no network calls, but the
 * deposit/release path then runs unverified — a non-production convenience
 * only.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * Deposit evidence captured at the deposit_paid transition (Stage 22,
 * audit C2: verify-before-credit). `verified` is true only when a payment
 * provider confirmed the reference (status success + exact kobo amount).
 */
export interface DepositEvidence {
  reference: string;
  verified: boolean;
}

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
    @Optional() @Inject(ESCROW_PAYOUT_DRIVER) private readonly payoutDriver?: EscrowPayoutDriverPort,
    @Optional() @Inject(ESCROW_PAYOUT_REPOSITORY) private readonly payouts?: EscrowPayoutRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  async escrowForOrder(orderId: string): Promise<EscrowRecord | undefined> {
    return this.escrows.findOne({ orderId });
  }

  /**
   * Lookup by provider-verified deposit reference (Stage 24, audit A1-2):
   * one verified charge may credit exactly one order, so verifyDeposit
   * consults this before crediting a reference.
   */
  async escrowForDepositReference(reference: string): Promise<EscrowRecord | undefined> {
    return this.escrows.findOne({ depositReference: reference });
  }

  /**
   * True when deposits/releases must be backed by provider verification:
   * a provider is wired, or the process runs in production (fail closed —
   * declarative payment evidence is a non-production convenience only).
   */
  private verificationRequired(): boolean {
    return Boolean(this.provider) || isProduction();
  }

  /**
   * True when money-out transitions must go through the recorded payout
   * rail (Stage 23): a payout driver is wired, or the process runs in
   * production (fail closed — declarative release/refund is a non-production
   * convenience only).
   */
  private payoutRequired(): boolean {
    return Boolean(this.payoutDriver) || isProduction();
  }

  /**
   * Stage 23 payout rail: drives one recorded, idempotent payout attempt for
   * a release/refund BEFORE the escrow may reach its terminal state.
   *
   * Fail-closed ordering:
   *   1. Production with a stub or unset driver → 503 immediately; NOTHING
   *      is persisted (no pending state, no payout attempt, no ledger-visible
   *      transition). This is the lazy use-time guard mirroring the Stage 22
   *      deposit path — deliberately not boot-fatal.
   *   2. The pending intent ('releasing'/'refunding') is persisted FIRST so a
   *      crash mid-payout leaves a resumable record.
   *   3. The attempt is CLAIMED under a deterministic idempotency key
   *      (Stage 24, audit A4-3): exactly one caller holds the 'in_progress'
   *      claim and drives the payout; a concurrent retry seeing a fresh
   *      claim is rejected 409 instead of invoking the driver a second
   *      time; an already-succeeded attempt replays without any driver
   *      call; the same key with a different payload is a 409 (the repo's
   *      idempotency contract).
   *   4. The driver is called by the claim holder only; the guarded
   *      finalize can never regress 'succeeded' to 'failed'. A driver
   *      failure leaves the escrow in the pending state and the attempt
   *      marked 'failed' so a retry re-claims and converges instead of
   *      double-paying.
   */
  private async executePayoutRail(
    record: EscrowRecord,
    status: 'released' | 'refunded',
    actorId: string
  ): Promise<EscrowRecord> {
    const kind: EscrowPayout['kind'] = status === 'released' ? 'release' : 'refund';
    const pending: EscrowStatus = status === 'released' ? 'releasing' : 'refunding';
    if (
      !this.payoutDriver ||
      !this.payouts ||
      (isProduction() && this.payoutDriver.name === 'stub')
    ) {
      await this.audit?.record({
        actorId,
        action: 'marketplace.escrow.payout_unavailable',
        entityType: 'escrow_record',
        entityId: record.id,
        metadata: {
          orderId: record.orderId,
          kind,
          driver: this.payoutDriver?.name ?? 'none',
          production: isProduction()
        }
      });
      throw new ServiceUnavailableException(
        `Escrow payout rail is not available for ${kind} (driver: ${this.payoutDriver?.name ?? 'none'}). ` +
          'Production requires ESCROW_PAYOUT_DRIVER=live with PAYOUT_PROVIDER_* configured; ' +
          `refusing to ${kind} escrow ${record.id} — nothing was recorded or posted.`
      );
    }
    let current = record;
    if (record.status !== pending) {
      // Persist the intent FIRST (guarded): after this write a crash can
      // only leave a resumable pending record, never an unrecorded payout.
      current = await this.persistTransition(record, pending, actorId);
    }
    const idempotencyKey = `escrow-payout:${kind}:${record.id}`;
    const payload = {
      escrowId: record.id,
      orderId: record.orderId,
      kind,
      amountKobo: record.amountKobo
    };
    const now = new Date().toISOString();
    const claim = await claimPayoutAttempt(this.payouts, {
      id: newId('payout'),
      ...payload,
      idempotencyKey,
      payloadHash: hashPayoutPayload(payload),
      provider: this.payoutDriver.name,
      createdAt: now,
      updatedAt: now
    });
    if (!claim.claimed) {
      // Replay of a retry after the driver succeeded but the process crashed
      // before the terminal write: never pay twice.
      return current;
    }
    try {
      const result = await this.payoutDriver.payout({
        ...payload,
        idempotencyKey,
        depositProviderReference: record.providerReference
      });
      await finalizePayoutAttempt(this.payouts, claim.attempt, {
        status: 'succeeded',
        providerReference: result.providerReference
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finalized = await finalizePayoutAttempt(this.payouts, claim.attempt, {
        status: 'failed',
        failureReason: message
      });
      if (finalized.status === 'succeeded') {
        // A concurrent claimant's driver call landed first: the payout
        // happened, so the escrow may proceed — never regress it to failed.
        return current;
      }
      await this.audit?.record({
        actorId,
        action: 'marketplace.escrow.payout_failed',
        entityType: 'escrow_record',
        entityId: record.id,
        metadata: {
          orderId: record.orderId,
          kind,
          pendingStatus: pending,
          driver: this.payoutDriver.name,
          idempotencyKey,
          error: message
        }
      });
      // The record stays in the pending state: retrying the same transition
      // resumes here and converges (the payout carries the same idempotency
      // key, and a succeeded attempt short-circuits the driver call).
      if (error instanceof ServiceUnavailableException) {
        // Fail-closed driver answers (e.g. live driver: PSSP disbursement
        // API not yet integrated) propagate as 503, never silently succeed.
        throw error;
      }
      throw new BadGatewayException(
        `Payout driver '${this.payoutDriver.name}' failed to ${kind} escrow ${record.id} ` +
          `(${message}); the escrow is '${pending}' and the transition must be retried`
      );
    }
    return current;
  }

  /**
   * Places the order total (integer kobo) into escrow. Idempotent per order:
   * an existing escrow record is returned unchanged so webhook/order retries
   * never double-hold. Deposit evidence (the buyer's payment reference and
   * whether a provider verified it) is persisted on the record so the
   * auto-release path can refuse unverified holds.
   *
   * Stage 24 (audit A1-1): when verification is required (a provider is
   * wired, or production), a hold without provider-verified deposit evidence
   * is REFUSED — an unfunded hold must never exist in a state where any
   * money-out path could pay it out. The direct POST /orders/:id/escrow
   * endpoint therefore re-verifies a caller-supplied payment reference
   * (MarketplaceService.verifyDepositForHold) before calling this.
   */
  async holdForOrder(
    orderId: string,
    actorId: string,
    deposit?: DepositEvidence
  ): Promise<EscrowRecord> {
    const existing = await this.escrowForOrder(orderId);
    if (existing) {
      return existing;
    }
    const order = await this.orders.getById(orderId);
    if (order.status === 'cancelled') {
      throw new BadRequestException(`Cannot hold escrow for a cancelled order (${orderId})`);
    }
    if (this.verificationRequired() && deposit?.verified !== true) {
      await this.audit?.record({
        actorId,
        action: 'marketplace.escrow.hold_blocked_unverified',
        entityType: 'escrow_record',
        entityId: orderId,
        metadata: { orderId, depositReference: deposit?.reference }
      });
      throw new ConflictException(
        `Refusing to hold escrow for order ${orderId} without provider-verified deposit ` +
          'evidence; supply the payment reference so the deposit can be verified first.'
      );
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
      depositReference: deposit?.reference,
      depositVerifiedAt: deposit?.verified ? heldAt.toISOString() : undefined,
      heldAt: heldAt.toISOString(),
      heldUntil: new Date(heldAt.getTime() + ESCROW_HOLD_TTL_MS).toISOString()
    };
    const created = await this.escrows.create(record);
    await this.audit?.record({
      actorId,
      action: 'marketplace.escrow.held',
      entityType: 'escrow_record',
      entityId: created.id,
      metadata: {
        orderId,
        amountKobo,
        provider: this.provider?.name ?? 'none',
        depositReference: deposit?.reference,
        depositVerified: deposit?.verified === true
      }
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
    // Stage 24 (audit A1-1): the verify-before-credit gate applies to EVERY
    // money-out transition, including this party-driven path. The single
    // exception is an admin resolving a DISPUTED escrow (the documented
    // admin-mediated path for legacy/unverified holds).
    return this.applyTransition(record, status, actor.id, {
      allowUnverified: isAdmin && record.status === 'disputed'
    });
  }

  /**
   * System-path release (delivery confirmation, order completion).
   * Verify-before-credit (Stage 22, audit C2): when verification is
   * required (a provider is wired, or production), an escrow whose deposit
   * was never provider-verified is NOT auto-released — the hold predates
   * the fix or was declared without evidence. Such holds need the
   * admin-mediated path (dispute resolution / manual release).
   */
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
    if (this.verificationRequired() && !record.depositVerifiedAt) {
      await this.audit?.record({
        actorId,
        action: 'marketplace.escrow.release_blocked_unverified',
        entityType: 'escrow_record',
        entityId: record.id,
        metadata: { orderId, depositReference: record.depositReference }
      });
      throw new ConflictException(
        `Escrow ${record.id} for order ${orderId} has no provider-verified deposit; ` +
          'refusing auto-release. Resolve through the admin-mediated path.'
      );
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
   *
   * Stage 24 (audit A1-1): when verification is required, an EXPIRED but
   * never-verified hold is NOT refunded — refunding it would pay out money
   * that was never deposited. The sweep skips it (audited) and leaves it
   * for the admin-mediated dispute path.
   */
  async expireHeldEscrows(now: string = new Date().toISOString()): Promise<EscrowRecord[]> {
    const held = await this.escrows.find({ status: 'held' });
    const expired: EscrowRecord[] = [];
    for (const record of held) {
      if (!record.heldUntil || record.heldUntil > now) {
        continue;
      }
      if (this.verificationRequired() && !record.depositVerifiedAt) {
        await this.audit?.record({
          actorId: 'system',
          action: 'marketplace.escrow.expiry_blocked_unverified',
          entityType: 'escrow_record',
          entityId: record.id,
          metadata: { orderId: record.orderId, depositReference: record.depositReference }
        });
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
    actorId: string,
    options?: { allowUnverified?: boolean }
  ): Promise<EscrowRecord> {
    let current = record;
    const moneyOut = status === 'released' || status === 'refunded';
    // Stage 24 (audit A1-1): verify-before-credit on EVERY money-out path —
    // party-driven transitions, system release/refund, and the expiry sweep
    // alike. Only the admin-mediated dispute resolution may move money for
    // an unverified hold (opts.allowUnverified, set by transition()).
    if (
      moneyOut &&
      !options?.allowUnverified &&
      this.verificationRequired() &&
      !record.depositVerifiedAt
    ) {
      await this.audit?.record({
        actorId,
        action: 'marketplace.escrow.money_out_blocked_unverified',
        entityType: 'escrow_record',
        entityId: record.id,
        metadata: { orderId: record.orderId, targetStatus: status, depositReference: record.depositReference }
      });
      throw new ConflictException(
        `Escrow ${record.id} has no provider-verified deposit; refusing ${status}. ` +
          'Resolve through the admin-mediated dispute path.'
      );
    }
    const providerBacked = moneyOut && record.providerReference && this.provider;
    if (moneyOut && this.payoutRequired()) {
      // Stage 23: the disbursement rail owns money-out transitions whenever a
      // payout driver is wired (and ALWAYS in production — fail closed).
      current = await this.executePayoutRail(record, status, actorId);
    } else if (providerBacked) {
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
