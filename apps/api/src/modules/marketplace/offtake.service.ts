import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException
} from '@nestjs/common';
import type {
  Invoice,
  LedgerJournalEntry,
  MarketplaceListing,
  Order,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import {
  COMMODITY_LOT_REPOSITORY,
  HARVEST_FORWARD_CONTRACT_REPOSITORY,
  INVOICE_REPOSITORY,
  LISTING_REPOSITORY,
  ORDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { CommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import type { InvoiceRepository } from '../../database/repositories/invoice.repository.js';
import type { ListingRepository } from '../../database/repositories/listing.repository.js';
import type { OrderRepository } from '../../database/repositories/order.repository.js';
import type {
  OfftakeContractRepository,
  OfftakeDeliveryTxInput
} from '../../database/repositories/offtake.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { MarketplaceService } from './marketplace.service.js';
import {
  allMilestonesMet,
  assertValidPriceBand,
  buyerEscrowAccountCode,
  buyerPenaltyPayableAccountCode,
  contractEscrowLiabilityAccountCode,
  coopPenaltyReceivableAccountCode,
  coopReceivableAccountCode,
  defaultPenaltyKobo,
  defaultPenaltyLedgerKey,
  deliveryAmountKobo,
  deliveryLedgerIdempotencyKey,
  effectiveMilestoneStatus,
  isIsoCalendarDate,
  milestoneStatusAfterDelivery,
  priceWithinBand,
  settlementLedgerIdempotencyKey,
  validateMilestonePlan,
  type OfftakeAmendment,
  type OfftakeContract,
  type OfftakeDelivery,
  type OfftakeMilestone,
  type OfftakePriceBand
} from './offtake.js';

export interface MilestonePlanInput {
  seq: number;
  dueDate: string;
  qtyKg: number;
}

export interface CreateOfftakeContractInput {
  cooperativeId: string;
  buyerOrgId: string;
  commodity: string;
  qtyKg: number;
  qualitySpec?: Record<string, unknown>;
  priceBand: { floorKoboPerKg: number; capKoboPerKg: number };
  windowStart: string;
  windowEnd: string;
  milestones: MilestonePlanInput[];
  idempotencyKey?: string;
}

export interface RecordDeliveryInput {
  milestoneSeq: number;
  lotId: string;
  qtyKg: number;
  priceKoboPerKg: number;
  idempotencyKey?: string;
  /** Buyer's payment reference funding this delivery's escrow hold. */
  depositReference?: string;
}

export interface OfftakeContractView {
  contract: OfftakeContract;
  milestones: OfftakeMilestone[];
  deliveries: OfftakeDelivery[];
}

/** V-34: one amendment proposal's terms (at least one must change). */
export interface ProposeAmendmentInput {
  priceBand?: OfftakePriceBand;
  windowEnd?: string;
  milestoneDueDates?: { seq: number; dueDate: string }[];
  note?: string;
}

export interface OfftakeDeliveryResult {
  delivery: OfftakeDelivery;
  milestone: OfftakeMilestone;
  contract: OfftakeContract;
  order: Order;
  invoice?: Invoice;
  replay: boolean;
}

export interface OfftakeCollateralView extends OfftakeContractView {
  totals: {
    qtyKg: number;
    deliveredQtyKg: number;
    deliveredAmountKobo: number;
    milestoneCount: number;
    milestonesMet: number;
    milestonesMissed: number;
  };
}

/** Domain event names (transactional outbox; tenant.id rides the payload actor/tenant context). */
export const OFFTAKE_EVENTS = {
  created: 'marketplace.offtake.created',
  accepted: 'marketplace.offtake.accepted',
  deliveryRecorded: 'marketplace.offtake.delivery_recorded',
  milestoneMet: 'marketplace.offtake.milestone_met',
  milestoneMissed: 'marketplace.offtake.milestone_missed',
  fulfilled: 'marketplace.offtake.fulfilled',
  defaulted: 'marketplace.offtake.defaulted',
  renegotiationRequired: 'marketplace.offtake.renegotiation_required',
  // V-34: versioned amendment flow.
  amendmentProposed: 'marketplace.offtake.amendment_proposed',
  amendmentAccepted: 'marketplace.offtake.amendment_accepted',
  amendmentRejected: 'marketplace.offtake.amendment_rejected',
  // V-35: buyer-default remedy (penalty receivable + re-marketing linkage).
  defaultRemedy: 'marketplace.offtake.default_remedy'
} as const;

/** OTel counters (tenant.id is attached automatically by TelemetryService). */
export const OFFTAKE_METRICS = {
  contractsTotal: 'marketplace.offtake_contracts_total',
  deliveredKgTotal: 'marketplace.offtake_delivered_kg_total'
} as const;

/** Deterministic rail ids so a mid-saga retry converges on the same rows. */
function railIds(deliveryKey: string): { deliveryId: string; orderId: string; listingId: string } {
  const suffix = createHash('sha256')
    .update(`offtake-delivery:${deliveryKey}`)
    .digest('hex')
    .slice(0, 24);
  return {
    deliveryId: `offdel-${suffix}`,
    orderId: `order-offdel-${suffix}`,
    listingId: `listing-offdel-${suffix}`
  };
}

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required');
  }
  return actor;
}

/**
 * Internal control-flow signal (V-50): the in-memory delivery claim lost to
 * a same-key twin. The saga wrapper unwinds ONLY the reservation and
 * replays the twin's record — the rails rows belong to the twin and must
 * never be compensated by the loser.
 */
class OfftakeDeliveryClaimConflict extends Error {
  constructor() {
    super('offtake delivery claim lost to a same-key twin');
    this.name = 'OfftakeDeliveryClaimConflict';
  }
}

function isAdmin(actor: User): boolean {
  return actor.roles.includes('admin');
}

/** Today as an ISO calendar date (lexicographically comparable to due dates). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Harvest Forward Contracts (Stage 27 Batch 3, Innovation 18) — milestone-
 * tracked offtake agreements between a cooperative (chapter_lead) and an
 * aggregator (buyer). Composition over existing modules:
 *
 *   - marketplace: deliveries ride the order state machine (confirm ->
 *     deposit_paid) so deposit verification, auto-invoice and the escrow
 *     hold all run through the EXISTING guarded rails — settlement later
 *     inherits the same payment-provider/payout gates (stub -> 503 in
 *     production, nothing recorded);
 *   - traceability: the delivery lot is mandatory evidence (no lot, no
 *     milestone progress) and must belong to the selling cooperative;
 *   - finance: the escrow-hold and settlement journals post through
 *     LedgerService semantics (balanced, integer kobo, idempotency-keyed);
 *     on PostgreSQL the delivery claim + milestone accumulation + journal +
 *     outbox events commit in ONE transaction (recordDeliveryTx);
 *   - credit: collateralView() is the read-only underwriting input.
 *
 * The counterparty model is deliberately defensive about the in-flight
 * coop-pool work (#2): cooperativeId is the acting chapter_lead's user id
 * today and can be a pool id unchanged once pools land — nothing here
 * imports from the pool branch.
 */
@Injectable()
export class OfftakeService implements OnModuleInit {
  private readonly logger = new Logger(OfftakeService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly ledger: LedgerService,
    private readonly marketplace: MarketplaceService,
    private readonly escrow: EscrowService,
    private readonly invoices: InvoiceService,
    private readonly profiles: ProfilesService,
    @Inject(HARVEST_FORWARD_CONTRACT_REPOSITORY)
    private readonly contracts: OfftakeContractRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(INVOICE_REPOSITORY) private readonly invoiceRepo: InvoiceRepository,
    @Inject(LISTING_REPOSITORY) private readonly listings: ListingRepository,
    @Inject(COMMODITY_LOT_REPOSITORY) private readonly lots: CommodityLotRepository,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly telemetry?: TelemetryService
  ) {}

  /**
   * Settlement leg: when a delivery's escrow is released through the
   * existing rails, move the obligation on the ledger (DR the contract
   * escrow liability, CR the cooperative's offtake receivable) through
   * LedgerService — idempotency-keyed per escrow, so replays never
   * double-post. Best-effort listener: a posting failure is logged for
   * reconciliation, never thrown back into the escrow fan-out.
   */
  onModuleInit(): void {
    this.events.on('marketplace.escrow.status_changed', (event) => {
      void this.settleReleasedEscrow(event).catch((error: unknown) => {
        this.logger.error(
          `offtake settlement posting failed for event ${event.id}: ${(error as Error)?.message ?? error}`
        );
      });
    });
  }

  /** Drafts a contract (two-party handshake, step 1): terms + milestone plan + dormant evidence. */
  async createContract(
    actor: User | null,
    input: CreateOfftakeContractInput
  ): Promise<{ contract: OfftakeContract; milestones: OfftakeMilestone[] }> {
    const caller = requireActor(actor);
    if (
      caller.id !== input.cooperativeId &&
      caller.id !== input.buyerOrgId &&
      !isAdmin(caller)
    ) {
      throw new ForbiddenException('Only a contract party (or admin) can draft an offtake contract');
    }
    if (input.cooperativeId === input.buyerOrgId) {
      throw new BadRequestException('The cooperative and the buyer must be different parties');
    }
    if (!input.commodity.trim()) {
      throw new BadRequestException('commodity is required');
    }
    if (!Number.isSafeInteger(input.qtyKg) || input.qtyKg <= 0) {
      throw new BadRequestException('qtyKg must be a positive integer');
    }
    if (
      !isIsoCalendarDate(input.windowStart) ||
      !isIsoCalendarDate(input.windowEnd) ||
      input.windowEnd <= input.windowStart
    ) {
      throw new BadRequestException('windowStart/windowEnd must be ISO dates with windowEnd > windowStart');
    }
    assertValidPriceBand(input.priceBand);
    validateMilestonePlan(input.milestones, input);
    if (input.idempotencyKey) {
      const existing = await this.contracts.findOne({ idempotencyKey: input.idempotencyKey });
      if (existing) {
        return { contract: existing, milestones: await this.contracts.listMilestones(existing.id) };
      }
    }
    // The dormant per-delivery listings anchor on the cooperative's profile
    // location; a cooperative without a profile cannot be located honestly
    // (fail closed — never invent a location).
    await this.profiles.get(input.cooperativeId).catch((error: unknown) => {
      if (error instanceof NotFoundException) {
        throw new UnprocessableEntityException(
          `COOP_PROFILE_REQUIRED: cooperative '${input.cooperativeId}' has no profile; ` +
            'the delivery listing location must come from a real profile, never a fabrication'
        );
      }
      throw error;
    });
    const now = new Date().toISOString();
    const contract: OfftakeContract = {
      id: newId('offtake'),
      cooperativeId: input.cooperativeId,
      buyerOrgId: input.buyerOrgId,
      commodity: input.commodity,
      qtyKg: input.qtyKg,
      qualitySpec: input.qualitySpec ?? {},
      priceBand: input.priceBand,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: 'draft',
      idempotencyKey: input.idempotencyKey,
      createdBy: caller.id,
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.contracts.create(contract);
    } catch (error) {
      // Concurrent create with the same idempotency key (pg 23505): replay.
      if (error instanceof ConflictException && input.idempotencyKey) {
        const existing = await this.contracts.findOne({ idempotencyKey: input.idempotencyKey });
        if (existing) {
          return { contract: existing, milestones: await this.contracts.listMilestones(existing.id) };
        }
      }
      throw error;
    }
    const milestones: OfftakeMilestone[] = input.milestones.map((milestone) => ({
      id: newId('offms'),
      contractId: contract.id,
      seq: milestone.seq,
      dueDate: milestone.dueDate,
      qtyKg: milestone.qtyKg,
      deliveredQtyKg: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    }));
    await this.contracts.addMilestones(milestones);
    await this.events.publish(
      OFFTAKE_EVENTS.created,
      {
        contractId: contract.id,
        cooperativeId: contract.cooperativeId,
        buyerOrgId: contract.buyerOrgId,
        commodity: contract.commodity,
        qtyKg: contract.qtyKg
      },
      caller.id
    );
    this.telemetry?.increment(OFFTAKE_METRICS.contractsTotal, 1, { status: 'draft' });
    await this.audit?.record({
      actorId: caller.id,
      action: 'marketplace.offtake.created',
      entityType: 'offtake_contract',
      entityId: contract.id,
      metadata: {
        cooperativeId: contract.cooperativeId,
        buyerOrgId: contract.buyerOrgId,
        qtyKg: contract.qtyKg
      }
    });
    return { contract, milestones };
  }

  /**
   * Buyer countersign (handshake step 2): draft -> active via a guarded
   * CAS on status='draft'. EXACTLY ONE accept wins — a concurrent or
   * repeated accept loses with 409 (livestock-passport transfer pattern).
   */
  async accept(actor: User | null, id: string): Promise<OfftakeContract> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(id);
    if (
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId &&
      !isAdmin(caller)
    ) {
      // No existence leak to non-parties.
      throw new NotFoundException(`Offtake contract '${id}' not found`);
    }
    if (caller.id !== contract.buyerOrgId && !isAdmin(caller)) {
      throw new ForbiddenException('Only the buyer (or admin) countersigns an offtake contract');
    }
    if (contract.status !== 'draft') {
      throw new ConflictException(
        `Offtake contract '${id}' is '${contract.status}'; exactly one accept is allowed`
      );
    }
    const acceptedAt = new Date().toISOString();
    const event = this.events.build(
      OFFTAKE_EVENTS.accepted,
      { contractId: id, cooperativeId: contract.cooperativeId, buyerOrgId: contract.buyerOrgId },
      caller.id
    );
    const updated = await this.contracts.updateExpected(
      id,
      { status: 'active', acceptedAt, updatedAt: acceptedAt },
      { status: 'draft' },
      event
    );
    if (this.contracts.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    this.telemetry?.increment(OFFTAKE_METRICS.contractsTotal, 1, { status: 'active' });
    await this.audit?.record({
      actorId: caller.id,
      action: 'marketplace.offtake.accepted',
      entityType: 'offtake_contract',
      entityId: id,
      metadata: { cooperativeId: contract.cooperativeId, buyerOrgId: contract.buyerOrgId }
    });
    return updated;
  }

  /** Both parties' scoped view (non-parties get 404 — no existence leak). */
  async getContract(actor: User | null, id: string): Promise<OfftakeContractView> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(id);
    if (
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId &&
      !isAdmin(caller)
    ) {
      throw new NotFoundException(`Offtake contract '${id}' not found`);
    }
    return this.buildView(contract);
  }

  /**
   * Credit-side read-only underwriting input. V-61: scoped to the contract
   * parties (the cooperative owner and the buyer on the contract) plus
   * admin and regulator; everyone else gets 403. NOTE: no contract↔lender
   * schema linkage exists — one is deliberately NOT invented here. Lender
   * visibility (consent/application-scoped reads) is deferred to the V-31
   * design item; until it lands, lenders are refused like any other
   * non-party.
   */
  async collateralView(actor: User | null, contractId: string): Promise<OfftakeCollateralView> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(contractId);
    const privileged = isAdmin(caller) || caller.roles.includes('regulator');
    if (
      !privileged &&
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId
    ) {
      throw new ForbiddenException(
        'Only a contract party, an administrator or a regulator may read offtake collateral'
      );
    }
    const view = await this.buildView(contract);
    const deliveredQtyKg = view.milestones.reduce((sum, milestone) => sum + milestone.deliveredQtyKg, 0);
    const deliveredAmountKobo = view.deliveries.reduce((sum, delivery) => sum + delivery.amountKobo, 0);
    const today = todayIso();
    return {
      ...view,
      totals: {
        qtyKg: contract.qtyKg,
        deliveredQtyKg,
        deliveredAmountKobo,
        milestoneCount: view.milestones.length,
        milestonesMet: view.milestones.filter((milestone) => milestone.status === 'met').length,
        milestonesMissed: view.milestones.filter(
          (milestone) => effectiveMilestoneStatus(milestone, today) === 'missed'
        ).length
      }
    };
  }

  /**
   * Delivery saga: traceability lot -> milestone -> auto-invoice -> escrow
   * hold. The order/invoice/escrow rails are all idempotent per
   * deterministic id or per order, so a mid-saga retry with the same
   * idempotency key converges; on PostgreSQL the delivery claim, milestone
   * accumulation, escrow-hold journal and outbox events then commit in ONE
   * transaction. A price outside the contracted band is NEVER silently
   * re-priced: the delivery is refused and a renegotiation event emitted.
   */
  async recordDelivery(
    actor: User | null,
    contractId: string,
    input: RecordDeliveryInput
  ): Promise<OfftakeDeliveryResult> {
    const run = () => this.recordDeliveryInner(actor, contractId, input);
    return this.telemetry
      ? this.telemetry.withSpan('marketplace.offtake.delivery', { contract_id: contractId }, run)
      : run();
  }

  private async recordDeliveryInner(
    actor: User | null,
    contractId: string,
    input: RecordDeliveryInput
  ): Promise<OfftakeDeliveryResult> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(contractId);
    if (
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId &&
      !isAdmin(caller)
    ) {
      throw new NotFoundException(`Offtake contract '${contractId}' not found`);
    }
    if (caller.id !== contract.cooperativeId && !isAdmin(caller)) {
      throw new ForbiddenException('Only the cooperative (or admin) records deliveries');
    }
    if (input.idempotencyKey) {
      const existing = await this.contracts.deliveryByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return this.deliveryResult(contractId, existing, true);
      }
    }
    if (contract.status !== 'active') {
      throw new ConflictException(
        `Offtake contract '${contractId}' is '${contract.status}'; deliveries record only against an active contract`
      );
    }
    const milestone = await this.contracts.milestoneBySeq(contractId, input.milestoneSeq);
    if (!milestone) {
      throw new NotFoundException(
        `Offtake contract '${contractId}' has no milestone seq ${input.milestoneSeq}`
      );
    }
    if (milestone.status !== 'pending' && milestone.status !== 'partial') {
      throw new ConflictException(
        `Milestone ${input.milestoneSeq} of contract '${contractId}' is '${milestone.status}' and cannot accept deliveries`
      );
    }
    if (todayIso() > milestone.dueDate) {
      throw new ConflictException(
        `Milestone ${input.milestoneSeq} of contract '${contractId}' is past its due date ` +
          `(${milestone.dueDate}); it is missed — renegotiate instead of delivering late`
      );
    }
    if (!priceWithinBand(contract.priceBand, input.priceKoboPerKg)) {
      await this.events.publish(
        OFFTAKE_EVENTS.renegotiationRequired,
        {
          contractId,
          milestoneSeq: input.milestoneSeq,
          priceKoboPerKg: input.priceKoboPerKg,
          band: contract.priceBand
        },
        caller.id
      );
      throw new UnprocessableEntityException(
        `Price ${input.priceKoboPerKg} kobo/kg is outside the contracted band ` +
          `[${contract.priceBand.floorKoboPerKg}, ${contract.priceBand.capKoboPerKg}]; ` +
          'the delivery is refused and must be renegotiated — never silently re-priced'
      );
    }
    if (input.priceKoboPerKg % 100 !== 0) {
      throw new BadRequestException(
        'priceKoboPerKg must be a whole-naira multiple of 100: the order/escrow rails ' +
          'settle in naira and money is never rounded'
      );
    }
    const qtyKg = input.qtyKg;
    if (milestone.deliveredQtyKg + qtyKg > milestone.qtyKg) {
      throw new ConflictException(
        `Milestone ${input.milestoneSeq} has ${milestone.qtyKg - milestone.deliveredQtyKg} kg ` +
          `remaining; a ${qtyKg} kg delivery would overshoot the contracted quantity`
      );
    }
    // Evidence-first: the traceability lot is MANDATORY and must be the
    // selling cooperative's own lot — no lot, no milestone progress.
    const lot = await this.lots.findById(input.lotId);
    if (!lot) {
      throw new UnprocessableEntityException(
        `TRACEABILITY_LOT_REQUIRED: lot '${input.lotId}' does not exist; ` +
          'deliveries without traceability evidence never progress a milestone'
      );
    }
    if (lot.ownerUserId !== contract.cooperativeId) {
      throw new ForbiddenException(
        `Lot '${input.lotId}' belongs to '${lot.ownerUserId}', not the selling cooperative ` +
          `'${contract.cooperativeId}'; delivery evidence must be the cooperative's own lot`
      );
    }
    const amountKobo = deliveryAmountKobo(qtyKg, input.priceKoboPerKg);
    const deliveryKey = input.idempotencyKey ?? newId('offdel');
    const ids = railIds(deliveryKey);
    // V-50 saga claim: reserve the milestone quantity with a guarded CAS
    // BEFORE driving the payment rails. Two concurrent deliveries against
    // the same milestone serialise HERE — the loser gets 409 before any
    // listing/order/invoice/escrow row exists, so a lost race can never
    // orphan a paid order + provider-verified escrow hold (the pre-fix
    // failure mode). Any failure after this point runs the compensating
    // unwind (cancel order -> escrow refund + invoice cancel, reverse the
    // hold journal, roll the reservation back) so a permanent commit
    // failure leaves NO orphan either.
    //
    // Crash-retry adoption: rails rows are created ONLY after the
    // reservation CAS, so an existing live order under this key's
    // deterministic id proves a prior attempt of THIS saga already holds
    // the reservation — adopt it and re-drive the idempotent rails instead
    // of double-reserving. A compensated attempt (cancelled order) is
    // terminal for the key: fail closed and ask for a fresh key. Residual
    // narrow window: a crash between the reservation CAS and the first
    // rails write leaves an unowned reservation (logged by compensation in
    // every other case) — reconciled by ops, never silently double-counted
    // here because the overshoot guard still bounds the milestone.
    let reservedQtyKg = milestone.deliveredQtyKg + qtyKg;
    let reservedByThisAttempt = false;
    if (input.idempotencyKey) {
      const priorOrder = await this.orders.findById(ids.orderId);
      if (priorOrder) {
        if (priorOrder.status === 'cancelled') {
          throw new ConflictException(
            `Offtake delivery key '${deliveryKey}' belongs to a saga that permanently failed ` +
              'and was compensated (order cancelled, escrow refunded); retry with a NEW idempotency key'
          );
        }
        if (milestone.deliveredQtyKg >= qtyKg) {
          reservedQtyKg = milestone.deliveredQtyKg; // prior attempt's reservation, adopted
        }
      }
    }
    if (reservedQtyKg !== milestone.deliveredQtyKg) {
      try {
        await this.contracts.updateMilestoneExpected(
          milestone.id,
          { deliveredQtyKg: reservedQtyKg },
          { status: milestone.status, deliveredQtyKg: milestone.deliveredQtyKg }
        );
        reservedByThisAttempt = true;
      } catch (error) {
        if (error instanceof ConflictException) {
          throw new ConflictException(
            `Milestone ${input.milestoneSeq} of contract '${contractId}' is being updated ` +
              'by a concurrent delivery; retry the operation'
          );
        }
        throw error;
      }
    }
    try {
      return await this.driveDeliveryRails(
        contract,
        milestone,
        input,
        caller,
        { amountKobo, deliveryKey, ids, reservedQtyKg, reservedByThisAttempt }
      );
    } catch (error) {
      if (error instanceof OfftakeDeliveryClaimConflict) {
        // A same-key twin owns this saga (it claimed the delivery row): it
        // also owns the rails rows, so unwind ONLY a reservation we made
        // ourselves and replay the twin's record — never compensate rails
        // we do not own.
        if (reservedByThisAttempt) {
          await this.rollbackMilestoneReservation(contract.id, milestone.id, qtyKg);
        }
        const existing = await this.contracts.deliveryByIdempotencyKey(deliveryKey);
        if (existing) {
          return this.deliveryResult(contractId, existing, true);
        }
        throw new ConflictException(
          `Offtake delivery key '${deliveryKey}' was claimed but no delivery is visible; retry`
        );
      }
      await this.compensateDeliverySaga({
        contractId: contract.id,
        milestoneId: milestone.id,
        qtyKg,
        orderId: ids.orderId,
        deliveryId: ids.deliveryId,
        deliveryKey
      });
      throw error;
    }
  }

  /**
   * Delivery saga rails + commit (runs under the V-50 milestone
   * reservation): listing -> order -> confirm/invoice -> deposit/escrow
   * hold -> atomic commit. Every rail row is idempotent per deterministic
   * id or per order, so a mid-saga retry with the same idempotency key
   * converges.
   */
  private async driveDeliveryRails(
    contract: OfftakeContract,
    milestone: OfftakeMilestone,
    input: RecordDeliveryInput,
    caller: User,
    saga: {
      amountKobo: number;
      deliveryKey: string;
      ids: { deliveryId: string; orderId: string; listingId: string };
      reservedQtyKg: number;
      reservedByThisAttempt: boolean;
    }
  ): Promise<OfftakeDeliveryResult> {
    const contractId = contract.id;
    const qtyKg = input.qtyKg;
    const { amountKobo, deliveryKey, ids, reservedQtyKg, reservedByThisAttempt } = saga;
    // 1. Dormant per-delivery listing: the invoice rail prices from the
    //    listing, so it carries THIS delivery's contracted-band price. Never
    //    buyer-searchable (isActive = false); the location comes from the
    //    cooperative's profile (validated at contract creation).
    const profile = await this.profiles.get(contract.cooperativeId);
    const listing: MarketplaceListing = {
      id: ids.listingId,
      sellerId: contract.cooperativeId,
      kind: 'produce',
      title: `Offtake delivery ${contractId} milestone ${input.milestoneSeq} (${contract.commodity})`,
      crop: contract.commodity,
      quantity: qtyKg,
      unit: 'kg',
      priceNaira: input.priceKoboPerKg / 100,
      location: profile.location,
      isActive: false
    };
    try {
      await this.listings.create(listing);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      } // deterministic id — a prior attempt already created it
    }
    // 2. The delivery order on the existing rails (deterministic id; the
    //    unique-key conflict on retry means "already created").
    const order: Order = {
      id: ids.orderId,
      listingId: ids.listingId,
      buyerId: contract.buyerOrgId,
      sellerId: contract.cooperativeId,
      quantity: qtyKg,
      totalNaira: amountKobo / 100,
      status: 'requested',
      escrowRequired: true,
      createdAt: new Date().toISOString()
    };
    try {
      await this.orders.create(order);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
    }
    // 3. confirm (seller side) -> auto-invoice at the delivery price;
    //    issueForOrder is idempotent per order, so re-drive it explicitly
    //    to close the crash window between the status write and issuance.
    await this.marketplace.setOrderStatus(ids.orderId, 'confirmed', caller);
    const invoice = await this.invoices.issueForOrder(ids.orderId, caller.id);
    // 4. deposit_paid (buyer side) -> verify-before-credit + escrow hold.
    //    Production with a stub/unset provider fails closed HERE (503/4xx)
    //    before the milestone or ledger ever move; the retry converges
    //    because every rail row above is idempotent.
    await this.marketplace.setOrderStatus(ids.orderId, 'deposit_paid', {
      id: contract.buyerOrgId,
      roles: ['buyer']
    }, { paymentReference: input.depositReference });
    const escrowRecord = await this.escrow.escrowForOrder(ids.orderId);
    // 5. The money-critical step: delivery claim + milestone accumulation +
    //    balanced escrow-hold journal + fulfilment CAS + outbox events.
    const delivery: OfftakeDelivery = {
      id: ids.deliveryId,
      contractId,
      milestoneId: milestone.id,
      lotId: input.lotId,
      orderId: ids.orderId,
      invoiceId: invoice.id,
      escrowId: escrowRecord?.id,
      qtyKg,
      priceKoboPerKg: input.priceKoboPerKg,
      amountKobo,
      idempotencyKey: deliveryKey,
      createdBy: caller.id,
      createdAt: new Date().toISOString()
    };
    const entry = this.buildEscrowHoldEntry(contract, delivery);
    delivery.ledgerEntryId = entry.id;
    return this.commitDelivery(
      contract,
      milestone,
      delivery,
      entry,
      caller.id,
      reservedQtyKg,
      reservedByThisAttempt
    );
  }

  /**
   * V-50 compensating unwind for a permanently failed delivery saga. Runs
   * best-effort in reverse order of the saga's commitments; every step is
   * individually guarded and logged so one failing step never blocks the
   * others (the original saga error always propagates to the caller):
   *   1. reverse the escrow-hold journal if this saga posted one (the
   *      in-memory path posts before finalizing; the pg journal rolls back
   *      with its transaction, so the lookup proves which case we are in);
   *   2. cancel the orphaned order through the order state machine — the
   *      cancel hook refunds the held escrow (ESCROW_TRANSITIONS refund
   *      path) and cancels the invoice, all idempotent no-ops when the saga
   *      never got that far;
   *   3. drop a committed-but-unfinalized delivery claim row (in-memory
   *      path) so a same-key retry re-drives instead of replaying an
   *      orphan; the pg claim rolls back with its transaction;
   *   4. roll the milestone quantity reservation back (and reopen a
   *      contract that was fulfilled off the rolled-back quantity).
   */
  private async compensateDeliverySaga(input: {
    contractId: string;
    milestoneId: string;
    qtyKg: number;
    orderId: string;
    deliveryId: string;
    deliveryKey: string;
  }): Promise<void> {
    const problems: string[] = [];
    try {
      const posted = await this.ledger.findEntryByIdempotencyKey(
        deliveryLedgerIdempotencyKey(input.deliveryKey)
      );
      if (posted) {
        await this.ledger.reverseEntry(posted.id, 'system');
      }
    } catch (error) {
      problems.push(`journal reversal: ${(error as Error)?.message ?? error}`);
    }
    try {
      const order = await this.orders.findById(input.orderId);
      if (order && order.status !== 'cancelled') {
        await this.marketplace.setOrderStatus(input.orderId, 'cancelled', {
          id: 'system',
          roles: ['admin']
        });
      }
    } catch (error) {
      problems.push(`order cancel/escrow refund: ${(error as Error)?.message ?? error}`);
    }
    try {
      await this.contracts.removeDelivery?.(input.deliveryId);
    } catch (error) {
      problems.push(`delivery claim removal: ${(error as Error)?.message ?? error}`);
    }
    try {
      await this.rollbackMilestoneReservation(input.contractId, input.milestoneId, input.qtyKg);
    } catch (error) {
      problems.push(`reservation rollback: ${(error as Error)?.message ?? error}`);
    }
    if (problems.length > 0) {
      this.logger.error(
        `offtake delivery saga compensation incomplete for order ${input.orderId} ` +
          `(manual reconciliation required): ${problems.join('; ')}`
      );
    }
  }

  /**
   * Rolls a V-50 milestone reservation back by `qtyKg`, guarded by CAS with
   * bounded retries (a concurrent reservation may sit on top — the delta is
   * subtracted from whatever is current, never blindly reset). The derived
   * status is recomputed so a 'met' milestone regresses to 'partial' when
   * its quantity is unwound; a 'missed' milestone is left to the sweep.
   * When the rollback un-mets a milestone, a contract that was fulfilled
   * off the rolled-back quantity is reopened (fulfilled -> active CAS).
   */
  private async rollbackMilestoneReservation(
    contractId: string,
    milestoneId: string,
    qtyKg: number
  ): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const milestones = await this.contracts.listMilestones(contractId);
      const current = milestones.find((candidate) => candidate.id === milestoneId);
      if (!current) {
        return;
      }
      const rolledQtyKg = current.deliveredQtyKg - qtyKg;
      if (rolledQtyKg < 0) {
        return; // already unwound (e.g. a prior compensation)
      }
      const patch: Partial<OfftakeMilestone> = { deliveredQtyKg: rolledQtyKg };
      if (current.status === 'pending' || current.status === 'partial' || current.status === 'met') {
        patch.status = milestoneStatusAfterDelivery(rolledQtyKg, current.qtyKg);
      }
      try {
        const updated = await this.contracts.updateMilestoneExpected(
          milestoneId,
          patch,
          { deliveredQtyKg: current.deliveredQtyKg }
        );
        if (updated.status !== 'met') {
          // Reopen a contract that was fulfilled off the rolled-back qty.
          await this.contracts
            .updateExpected(
              contractId,
              { status: 'active', updatedAt: new Date().toISOString() },
              { status: 'fulfilled' }
            )
            .catch((error: unknown) => {
              if (!(error instanceof ConflictException || error instanceof NotFoundException)) {
                throw error;
              }
            });
        }
        return;
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }
      }
    }
    this.logger.error(
      `offtake saga compensation: could not roll back the ${qtyKg} kg reservation ` +
        `on milestone '${milestoneId}' after 5 guarded attempts; manual reconciliation required`
    );
  }

  /** Balanced escrow-hold journal: DR buyer escrow asset, CR contract liability. */
  private buildEscrowHoldEntry(
    contract: OfftakeContract,
    delivery: OfftakeDelivery
  ): LedgerJournalEntry {
    return {
      id: randomUUID(),
      idempotencyKey: deliveryLedgerIdempotencyKey(delivery.idempotencyKey ?? delivery.id),
      referenceType: 'offtake_delivery',
      referenceId: delivery.id,
      description: `Offtake delivery escrow hold (${delivery.qtyKg} kg ${contract.commodity})`,
      postedAt: new Date().toISOString(),
      postings: [
        {
          accountCode: buyerEscrowAccountCode(contract.buyerOrgId),
          direction: 'debit',
          amountKobo: delivery.amountKobo
        },
        {
          accountCode: contractEscrowLiabilityAccountCode(contract.id),
          direction: 'credit',
          amountKobo: delivery.amountKobo
        }
      ]
    };
  }

  private async ensureEscrowAccounts(contract: OfftakeContract): Promise<void> {
    await this.ledger.ensureAccount({
      code: buyerEscrowAccountCode(contract.buyerOrgId),
      type: 'asset',
      ownerId: contract.buyerOrgId
    });
    await this.ledger.ensureAccount({
      code: contractEscrowLiabilityAccountCode(contract.id),
      type: 'liability',
      ownerId: contract.cooperativeId
    });
    await this.ledger.ensureAccount({
      code: coopReceivableAccountCode(contract.cooperativeId),
      type: 'liability',
      ownerId: contract.cooperativeId
    });
  }

  /**
   * The atomic core of the delivery saga. The milestone quantity was
   * ALREADY reserved by the caller (V-50), so this step verifies the
   * reservation is intact and finalizes the derived state — it never adds
   * quantity a second time. PostgreSQL: ONE transaction via
   * recordDeliveryTx (claim + reservation verification + journal +
   * fulfilment CAS + outbox). In-memory: the idempotency-key claim is the
   * arbiter and the journal posts through LedgerService
   * (idempotency-keyed) before the milestone state finalizes.
   */
  private async commitDelivery(
    contract: OfftakeContract,
    milestone: OfftakeMilestone,
    delivery: OfftakeDelivery,
    entry: LedgerJournalEntry,
    actorId: string,
    reservedQtyKg: number,
    reservedByThisAttempt: boolean
  ): Promise<OfftakeDeliveryResult> {
    await this.ensureEscrowAccounts(contract);
    if (this.contracts.transactionalDelivery && this.contracts.recordDeliveryTx) {
      let committed: DomainEvent[] = [];
      const txInput: OfftakeDeliveryTxInput = {
        contractId: contract.id,
        milestoneId: milestone.id,
        delivery,
        milestonePatch: {
          deliveredQtyKg: reservedQtyKg,
          status: milestoneStatusAfterDelivery(reservedQtyKg, milestone.qtyKg),
          linkedLotId: delivery.lotId,
          invoiceId: delivery.invoiceId,
          escrowId: delivery.escrowId
        },
        entry,
        buildEvents: ({ milestone: committedMilestone, fulfilled }) => {
          committed = this.deliveryEvents(contract, delivery, committedMilestone, fulfilled, actorId);
          return committed;
        }
      };
      const outcome = await this.contracts.recordDeliveryTx(txInput);
      if (outcome === 'replay') {
        const existing = await this.contracts.deliveryByIdempotencyKey(delivery.idempotencyKey!);
        if (existing) {
          // A same-key twin committed between our entry check and the
          // transaction: unwind only a reservation WE made (an adopted
          // crash-retry reservation belongs to the twin's committed saga).
          if (reservedByThisAttempt) {
            await this.rollbackMilestoneReservation(contract.id, milestone.id, delivery.qtyKg);
          }
          return this.deliveryResult(contract.id, existing, true);
        }
        throw new ConflictException(
          `Offtake delivery key '${delivery.idempotencyKey}' was claimed but no delivery is visible; retry`
        );
      }
      for (const event of committed) {
        this.events.emit(event);
      }
      this.deliveryCounters(contract, committed);
      return this.deliveryResult(contract.id, delivery, false);
    }
    // In-memory path (tests/dev): claim -> journal -> state -> events.
    let claimed: OfftakeDelivery;
    try {
      claimed = await this.contracts.addDelivery(delivery);
    } catch (error) {
      // 409 on key replay: a same-key twin owns this saga. The caller
      // unwinds our reservation and replays the twin's record — the rails
      // rows belong to the twin and are never compensated here.
      if (error instanceof ConflictException) {
        throw new OfftakeDeliveryClaimConflict();
      }
      throw error;
    }
    await this.ledger.postEntry(
      {
        idempotencyKey: entry.idempotencyKey,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        postings: entry.postings
      },
      actorId
    );
    // Finalize the derived milestone state ON TOP of the reservation (the
    // quantity was already claimed before the rails ran, V-50): the CAS
    // precondition proves our reservation is still intact, so concurrent
    // deliveries serialise and can never double-count or overshoot.
    const updatedMilestone = await this.contracts.updateMilestoneExpected(
      milestone.id,
      {
        status: milestoneStatusAfterDelivery(reservedQtyKg, milestone.qtyKg),
        linkedLotId: delivery.lotId,
        invoiceId: delivery.invoiceId,
        escrowId: delivery.escrowId
      },
      { deliveredQtyKg: reservedQtyKg }
    );
    const milestones = await this.contracts.listMilestones(contract.id);
    let fulfilled = false;
    if (allMilestonesMet(milestones)) {
      await this.contracts.updateExpected(
        contract.id,
        { status: 'fulfilled', updatedAt: new Date().toISOString() },
        { status: 'active' }
      );
      fulfilled = true;
    }
    const events = this.deliveryEvents(contract, claimed, updatedMilestone, fulfilled, actorId);
    for (const event of events) {
      await this.events.persist(event);
    }
    this.deliveryCounters(contract, events);
    return this.deliveryResult(contract.id, claimed, false);
  }

  /** Events derived from the COMMITTED milestone state (never a stale pre-read). */
  private deliveryEvents(
    contract: OfftakeContract,
    delivery: OfftakeDelivery,
    milestone: OfftakeMilestone,
    fulfilled: boolean,
    actorId: string
  ): DomainEvent[] {
    const events: DomainEvent[] = [
      this.events.build(
        OFFTAKE_EVENTS.deliveryRecorded,
        {
          contractId: contract.id,
          deliveryId: delivery.id,
          milestoneId: milestone.id,
          milestoneSeq: milestone.seq,
          lotId: delivery.lotId,
          orderId: delivery.orderId,
          invoiceId: delivery.invoiceId,
          escrowId: delivery.escrowId,
          qtyKg: delivery.qtyKg,
          amountKobo: delivery.amountKobo
        },
        actorId
      )
    ];
    if (milestone.status === 'met') {
      events.push(
        this.events.build(
          OFFTAKE_EVENTS.milestoneMet,
          { contractId: contract.id, milestoneId: milestone.id, milestoneSeq: milestone.seq },
          actorId
        )
      );
    }
    if (fulfilled) {
      events.push(
        this.events.build(OFFTAKE_EVENTS.fulfilled, { contractId: contract.id }, actorId)
      );
    }
    return events;
  }

  private deliveryCounters(contract: OfftakeContract, events: readonly DomainEvent[]): void {
    if (!this.telemetry) {
      return;
    }
    const delivered = events.find((event) => event.name === OFFTAKE_EVENTS.deliveryRecorded);
    if (delivered) {
      this.telemetry.increment(
        OFFTAKE_METRICS.deliveredKgTotal,
        (delivered.payload as { qtyKg: number }).qtyKg,
        {}
      );
    }
    if (events.some((event) => event.name === OFFTAKE_EVENTS.fulfilled)) {
      this.telemetry.increment(OFFTAKE_METRICS.contractsTotal, 1, { status: 'fulfilled' });
    }
  }

  /** Assembles the post-saga view (also the idempotent-replay response). */
  private async deliveryResult(
    contractId: string,
    delivery: OfftakeDelivery,
    replay: boolean
  ): Promise<OfftakeDeliveryResult> {
    const contract = await this.contracts.getById(contractId);
    const milestones = await this.contracts.listMilestones(contractId);
    const milestone = milestones.find((candidate) => candidate.id === delivery.milestoneId);
    const order = await this.orders.getById(delivery.orderId);
    const invoice = delivery.invoiceId
      ? await this.invoiceRepo.findById(delivery.invoiceId)
      : undefined;
    if (!milestone) {
      throw new NotFoundException(`Offtake milestone '${delivery.milestoneId}' not found`);
    }
    return {
      delivery,
      milestone,
      contract,
      order,
      invoice,
      replay
    };
  }

  /**
   * Settlement consumer: an escrow released through the existing rails
   * settles the matching delivery on the ledger — DR the contract escrow
   * liability, CR the cooperative's offtake receivable (the platform now
   * owes the coop; the payout itself rides the Stage-23 payout rail and
   * its 503-in-production gate). Idempotency-keyed per escrow.
   */
  private async settleReleasedEscrow(event: DomainEvent): Promise<void> {
    const payload = event.payload as { escrowId?: string; to?: string } | undefined;
    if (!payload?.escrowId || payload.to !== 'released') {
      return;
    }
    await this.postSettlementJournal(payload.escrowId);
  }

  /**
   * Posts the delivery settlement journal for one released offtake escrow.
   * Idempotency-keyed per escrow (`offtake-settle:<escrowId>`), so the
   * listener, a manual retry and the V-51 sweep all converge on ONE
   * identical journal — replays never double-post. Returns true when the
   * escrow belongs to an offtake delivery (journal posted or adopted).
   */
  private async postSettlementJournal(escrowId: string): Promise<boolean> {
    const milestone = await this.contracts.milestoneByEscrowId(escrowId);
    if (!milestone) {
      return false; // not an offtake escrow
    }
    const deliveries = await this.contracts.listDeliveries(milestone.contractId);
    const delivery = deliveries.find((candidate) => candidate.escrowId === escrowId);
    if (!delivery) {
      return false;
    }
    const contract = await this.contracts.getById(milestone.contractId);
    await this.ensureEscrowAccounts(contract);
    await this.ledger.postEntry(
      {
        idempotencyKey: settlementLedgerIdempotencyKey(escrowId),
        referenceType: 'offtake_settlement',
        referenceId: escrowId,
        description: `Offtake delivery settlement (escrow ${escrowId} released)`,
        postings: [
          {
            accountCode: contractEscrowLiabilityAccountCode(contract.id),
            direction: 'debit',
            amountKobo: delivery.amountKobo
          },
          {
            accountCode: coopReceivableAccountCode(contract.cooperativeId),
            direction: 'credit',
            amountKobo: delivery.amountKobo
          }
        ]
      },
      'system'
    );
    return true;
  }

  /**
   * V-51 durable settlement retry (admin). The escrow-release listener is a
   * best-effort in-process consumer (V-51): a single listener failure drops
   * the settlement journal because the outbox event is already consumed.
   * This sweep is the durable backstop: it finds every offtake delivery
   * whose escrow was RELEASED but has no `offtake-settle:<escrowId>`
   * journal and re-drives the posting. The posting is idempotency-keyed, so
   * the sweep is safe to run repeatedly and concurrently — re-drives
   * converge on the identical journal, never duplicate legs. A held or
   * refunded escrow (e.g. a V-50 compensated saga) never settles here.
   */
  async settlementSweep(actor: User | null): Promise<{ scanned: number; redriven: number }> {
    const caller = requireActor(actor);
    if (!isAdmin(caller)) {
      throw new ForbiddenException('Only admins run the offtake settlement sweep');
    }
    let scanned = 0;
    let redriven = 0;
    for (const contract of await this.contracts.find({})) {
      for (const delivery of await this.contracts.listDeliveries(contract.id)) {
        if (!delivery.escrowId) {
          continue;
        }
        scanned += 1;
        const existing = await this.ledger.findEntryByIdempotencyKey(
          settlementLedgerIdempotencyKey(delivery.escrowId)
        );
        if (existing) {
          continue; // journal already posted (listener or a prior sweep)
        }
        const record = await this.escrow.escrowForOrder(delivery.orderId);
        if (!record || record.id !== delivery.escrowId || record.status !== 'released') {
          continue; // only a released escrow owes a settlement journal
        }
        await this.postSettlementJournal(delivery.escrowId);
        redriven += 1;
      }
    }
    return { scanned, redriven };
  }

  /* ==================== V-34: renegotiation (contract amendments) ==========
   *
   * The 'renegotiation required' event (out-of-band price, missed deadlines)
   * previously had no state to land in. An amendment is a VERSIONED proposal
   * of new terms (price band / window end / open-milestone due dates) that
   * only takes effect when the OTHER party accepts it; acceptance CAS-bumps
   * the contract's termsVersion and rewrites the band/window/due dates, so
   * the sweep and the delivery band check read the amended terms from then
   * on. All transitions are CAS-guarded; the amendment rows are append-only
   * evidence (status moves only, never edits).
   */

  /**
   * Propose amended terms (either contract party). Supersedes any still-open
   * proposal (CAS per row). The proposal does NOT change the contract — only
   * acceptance does.
   */
  async proposeAmendment(
    actor: User | null,
    contractId: string,
    input: ProposeAmendmentInput
  ): Promise<OfftakeAmendment> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(contractId);
    if (caller.id !== contract.cooperativeId && caller.id !== contract.buyerOrgId) {
      throw new NotFoundException(`Offtake contract '${contractId}' not found`);
    }
    if (contract.status !== 'active') {
      throw new ConflictException(
        `Offtake contract '${contractId}' is '${contract.status}'; amendments propose only against an active contract`
      );
    }
    this.assertAmendmentTerms(contract, input);
    const existing = await this.contracts.listAmendments(contractId);
    // A new proposal supersedes any still-open ones (CAS each; a lost race
    // means a twin already decided it — the supersede of that one is moot).
    for (const open of existing.filter((amendment) => amendment.status === 'proposed')) {
      try {
        await this.contracts.updateAmendmentExpected(
          open.id,
          { status: 'superseded', decidedAt: new Date().toISOString() },
          { status: 'proposed' }
        );
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }
      }
    }
    const amendment: OfftakeAmendment = {
      id: newId('offamend'),
      contractId,
      seq: existing.length + 1,
      status: 'proposed',
      priceBand: input.priceBand,
      windowEnd: input.windowEnd,
      milestoneDueDates: input.milestoneDueDates,
      note: input.note?.trim() || undefined,
      proposedBy: caller.id,
      createdAt: new Date().toISOString()
    };
    try {
      await this.contracts.addAmendment(amendment);
    } catch (error) {
      // pg UNIQUE (contract_id, seq) / partial-unique 'proposed' → the twin
      // proposal won; surface as a conflict for an honest retry.
      if (error instanceof ConflictException) {
        throw new ConflictException(
          `A concurrent amendment raced this proposal on contract '${contractId}'; re-read and retry`
        );
      }
      throw error;
    }
    await this.events.publish(
      OFFTAKE_EVENTS.amendmentProposed,
      { contractId, amendmentId: amendment.id, seq: amendment.seq, proposedBy: caller.id },
      caller.id
    );
    await this.audit?.record({
      actorId: caller.id,
      action: 'marketplace.offtake.amendment_proposed',
      entityType: 'offtake_contract',
      entityId: contractId,
      metadata: { amendmentId: amendment.id, seq: amendment.seq }
    });
    return amendment;
  }

  /**
   * Accept an open proposal: the COUNTERPARTY (never the proposer; an admin
   * may mediate) accepts. CAS-claims the proposal, then applies the amended
   * terms to the contract with a termsVersion bump (CAS on the pre-read
   * updatedAt), then re-dates the named OPEN milestones. A milestone the
   * sweep already marked 'missed' is REVIVED (back to pending/partial) when
   * the amendment gives it a due date in the future — that is the point of
   * renegotiation.
   */
  async acceptAmendment(
    actor: User | null,
    contractId: string,
    amendmentId: string
  ): Promise<{ contract: OfftakeContract; amendment: OfftakeAmendment }> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(contractId);
    if (
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId &&
      !isAdmin(caller)
    ) {
      throw new NotFoundException(`Offtake contract '${contractId}' not found`);
    }
    const amendment = await this.contracts.amendmentById(amendmentId);
    if (!amendment || amendment.contractId !== contractId) {
      throw new NotFoundException(`Offtake amendment '${amendmentId}' not found on contract '${contractId}'`);
    }
    if (amendment.status === 'accepted') {
      // Idempotent replay: re-read the contract at its current terms.
      return { contract: await this.contracts.getById(contractId), amendment };
    }
    if (amendment.status !== 'proposed') {
      throw new ConflictException(
        `Amendment '${amendmentId}' is '${amendment.status}'; only a proposed amendment can be accepted`
      );
    }
    if (amendment.proposedBy === caller.id && !isAdmin(caller)) {
      throw new ForbiddenException('The proposer cannot accept their own amendment');
    }
    if (contract.status !== 'active') {
      throw new ConflictException(
        `Offtake contract '${contractId}' is '${contract.status}'; amendments land only on an active contract`
      );
    }
    const decidedAt = new Date().toISOString();
    const accepted = await this.contracts.updateAmendmentExpected(
      amendmentId,
      { status: 'accepted', decidedAt },
      { status: 'proposed' }
    );
    const nextVersion = (contract.termsVersion ?? 1) + 1;
    const updatedContract = await this.contracts.updateExpected(
      contractId,
      {
        priceBand: amendment.priceBand ?? contract.priceBand,
        windowEnd: amendment.windowEnd ?? contract.windowEnd,
        termsVersion: nextVersion,
        updatedAt: new Date().toISOString()
      },
      { status: 'active', updatedAt: contract.updatedAt }
    );
    // Re-date open milestones (and revive freshly-missed ones when the new
    // due date is in the future).
    const today = todayIso();
    for (const change of amendment.milestoneDueDates ?? []) {
      const milestone = await this.contracts.milestoneBySeq(contractId, change.seq);
      if (!milestone) {
        continue;
      }
      const open = milestone.status === 'pending' || milestone.status === 'partial';
      const revivable = milestone.status === 'missed' && change.dueDate >= today;
      if (!open && !revivable) {
        continue; // met milestones never move
      }
      await this.contracts.updateMilestoneExpected(
        milestone.id,
        {
          dueDate: change.dueDate,
          status: revivable
            ? milestone.deliveredQtyKg > 0
              ? 'partial'
              : 'pending'
            : milestone.status
        },
        { status: milestone.status }
      );
    }
    await this.events.publish(
      OFFTAKE_EVENTS.amendmentAccepted,
      {
        contractId,
        amendmentId,
        termsVersion: nextVersion,
        priceBand: updatedContract.priceBand,
        windowEnd: updatedContract.windowEnd
      },
      caller.id
    );
    await this.audit?.record({
      actorId: caller.id,
      action: 'marketplace.offtake.amendment_accepted',
      entityType: 'offtake_contract',
      entityId: contractId,
      metadata: { amendmentId, termsVersion: nextVersion }
    });
    return { contract: updatedContract, amendment: accepted };
  }

  /** Reject an open proposal (counterparty or admin). CAS-guarded. */
  async rejectAmendment(
    actor: User | null,
    contractId: string,
    amendmentId: string
  ): Promise<OfftakeAmendment> {
    const caller = requireActor(actor);
    const contract = await this.contracts.getById(contractId);
    if (
      caller.id !== contract.cooperativeId &&
      caller.id !== contract.buyerOrgId &&
      !isAdmin(caller)
    ) {
      throw new NotFoundException(`Offtake contract '${contractId}' not found`);
    }
    const amendment = await this.contracts.amendmentById(amendmentId);
    if (!amendment || amendment.contractId !== contractId) {
      throw new NotFoundException(`Offtake amendment '${amendmentId}' not found on contract '${contractId}'`);
    }
    if (amendment.status === 'rejected') {
      return amendment; // idempotent replay
    }
    if (amendment.status !== 'proposed') {
      throw new ConflictException(
        `Amendment '${amendmentId}' is '${amendment.status}'; only a proposed amendment can be rejected`
      );
    }
    const rejected = await this.contracts.updateAmendmentExpected(
      amendmentId,
      { status: 'rejected', decidedAt: new Date().toISOString() },
      { status: 'proposed' }
    );
    await this.events.publish(
      OFFTAKE_EVENTS.amendmentRejected,
      { contractId, amendmentId },
      caller.id
    );
    return rejected;
  }

  /** Validates one amendment proposal's terms against the current contract. */
  private assertAmendmentTerms(contract: OfftakeContract, input: ProposeAmendmentInput): void {
    if (!input.priceBand && !input.windowEnd && !input.milestoneDueDates?.length) {
      throw new BadRequestException('An amendment must change at least one term');
    }
    if (input.priceBand) {
      assertValidPriceBand(input.priceBand);
    }
    const effectiveWindowEnd = input.windowEnd ?? contract.windowEnd;
    if (input.windowEnd !== undefined) {
      if (!isIsoCalendarDate(input.windowEnd) || input.windowEnd <= contract.windowStart) {
        throw new BadRequestException(
          `windowEnd must be an ISO date after the window start (${contract.windowStart})`
        );
      }
    }
    for (const change of input.milestoneDueDates ?? []) {
      if (!Number.isSafeInteger(change.seq) || change.seq <= 0) {
        throw new BadRequestException('milestoneDueDates entries need a positive milestone seq');
      }
      if (
        !isIsoCalendarDate(change.dueDate) ||
        change.dueDate < contract.windowStart ||
        change.dueDate > effectiveWindowEnd
      ) {
        throw new BadRequestException(
          `Milestone ${change.seq}: amended dueDate must be an ISO date inside the (amended) window ` +
            `(${contract.windowStart}..${effectiveWindowEnd})`
        );
      }
    }
  }

  /**
   * Missed/defaulted sweep (admin): milestones past their due_date while
   * unmet become 'missed' (never before the due date); a contract past its
   * delivery window with milestones still open defaults. Guarded CAS on
   * every write — safe to run repeatedly and concurrently.
   */
  async sweep(
    actor: User | null,
    now?: string
  ): Promise<{ missedMilestones: number; defaultedContracts: number }> {
    const caller = requireActor(actor);
    if (!isAdmin(caller)) {
      throw new ForbiddenException('Only admins run the offtake missed/defaulted sweep');
    }
    const today = (now ?? todayIso()).slice(0, 10);
    let missedMilestones = 0;
    let defaultedContracts = 0;
    const active = await this.contracts.find({ status: 'active' });
    for (const contract of active) {
      const milestones = await this.contracts.listMilestones(contract.id);
      for (const milestone of milestones) {
        if (
          (milestone.status === 'pending' || milestone.status === 'partial') &&
          milestone.dueDate < today
        ) {
          try {
            await this.contracts.updateMilestoneExpected(
              milestone.id,
              { status: 'missed' },
              { status: milestone.status }
            );
          } catch (error) {
            if (!(error instanceof ConflictException)) {
              throw error;
            }
            continue; // a concurrent transition won
          }
          missedMilestones += 1;
          await this.events.publish(
            OFFTAKE_EVENTS.milestoneMissed,
            { contractId: contract.id, milestoneId: milestone.id, milestoneSeq: milestone.seq },
            caller.id
          );
        }
      }
      if (contract.windowEnd < today) {
        const event = this.events.build(
          OFFTAKE_EVENTS.defaulted,
          { contractId: contract.id, cooperativeId: contract.cooperativeId, buyerOrgId: contract.buyerOrgId },
          caller.id
        );
        try {
          await this.contracts.updateExpected(
            contract.id,
            { status: 'defaulted', updatedAt: new Date().toISOString() },
            { status: 'active' },
            event
          );
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          continue;
        }
        if (this.contracts.transactionalOutbox) {
          this.events.emit(event);
        } else {
          await this.events.persist(event);
        }
        defaultedContracts += 1;
        this.telemetry?.increment(OFFTAKE_METRICS.contractsTotal, 1, { status: 'defaulted' });
        // V-35: buyer-default remedy — penalty receivable + re-marketing.
        await this.applyDefaultRemedy(contract, milestones, caller.id);
      }
    }
    return { missedMilestones, defaultedContracts };
  }

  /**
   * V-35 buyer-default remedy (sweep step, runs exactly once per contract —
   * gated by the active→defaulted CAS the caller just won):
   *
   *   1. Penalty receivable: 10% of the undelivered value at the band floor
   *      posts as a BALANCED journal — DR coop:<coop>:default_penalty_receivable
   *      (asset) / CR org:<buyer>:default_penalty_payable (liability) —
   *      idempotency-keyed per contract. This is a RECEIVABLE RECORD ONLY:
   *      collecting it moves money, which stays behind the existing
   *      fail-closed payout-rail stubs until the E-01 external gate lands.
   *   2. Assisted re-marketing: the stranded lot (the contract's latest
   *      linked traceability lot) is listed on the marketplace at the band
   *      floor for the undelivered quantity, and the contract records the
   *      linkage (remarketedListingId) so ops/credit can follow it.
   *
   * A remedy failure after the default CAS is logged + audited loudly
   * (never silently swallowed) — the ledger journal key makes a manual
   * re-drive safe.
   */
  private async applyDefaultRemedy(
    contract: OfftakeContract,
    milestones: readonly OfftakeMilestone[],
    actorId: string
  ): Promise<void> {
    const undeliveredQtyKg = milestones.reduce(
      (sum, milestone) => sum + Math.max(0, milestone.qtyKg - milestone.deliveredQtyKg),
      0
    );
    if (undeliveredQtyKg <= 0) {
      return; // fully delivered (fulfilment CAS is a separate path)
    }
    const penaltyKobo = defaultPenaltyKobo(contract, undeliveredQtyKg);
    let remarketedListingId: string | undefined;
    try {
      if (penaltyKobo > 0) {
        await this.ledger.ensureAccount({
          code: coopPenaltyReceivableAccountCode(contract.cooperativeId),
          type: 'asset',
          ownerId: contract.cooperativeId
        });
        await this.ledger.ensureAccount({
          code: buyerPenaltyPayableAccountCode(contract.buyerOrgId),
          type: 'liability',
          ownerId: contract.buyerOrgId
        });
        await this.ledger.postEntry(
          {
            idempotencyKey: defaultPenaltyLedgerKey(contract.id),
            referenceType: 'offtake_default_penalty',
            referenceId: contract.id,
            description:
              `Buyer-default penalty on offtake contract ${contract.id}: ${penaltyKobo} kobo ` +
              `(${undeliveredQtyKg} kg undelivered at band floor)`,
            postings: [
              {
                accountCode: coopPenaltyReceivableAccountCode(contract.cooperativeId),
                direction: 'debit',
                amountKobo: penaltyKobo
              },
              {
                accountCode: buyerPenaltyPayableAccountCode(contract.buyerOrgId),
                direction: 'credit',
                amountKobo: penaltyKobo
              }
            ]
          },
          actorId
        );
      }
      // Assisted re-marketing: stranded lot → new marketplace listing at the
      // band floor. The location comes from the cooperative's real profile
      // (never fabricated; a missing profile skips the listing, honestly).
      const strandedLotId = [...milestones].reverse().find((m) => m.linkedLotId)?.linkedLotId;
      const profile = await this.profiles.get(contract.cooperativeId).catch(() => undefined);
      if (profile?.location) {
        // floor kobo/kg → naira is exact (integer kobo = ≤2 decimal naira).
        const listing = await this.marketplace.createListing({
          sellerId: contract.cooperativeId,
          kind: 'produce',
          title: `[remarketed] ${contract.commodity} — offtake ${contract.id} default`,
          crop: contract.commodity,
          quantity: undeliveredQtyKg,
          unit: 'kg',
          priceNaira: contract.priceBand.floorKoboPerKg / 100,
          location: profile.location
        });
        remarketedListingId = listing.id;
      }
      const patch: Partial<OfftakeContract> = { updatedAt: new Date().toISOString() };
      if (penaltyKobo > 0) {
        patch.defaultPenaltyKobo = penaltyKobo;
      }
      if (remarketedListingId) {
        patch.remarketedListingId = remarketedListingId;
      }
      await this.contracts.updateExpected(contract.id, patch, { status: 'defaulted' });
      await this.events.publish(
        OFFTAKE_EVENTS.defaultRemedy,
        {
          contractId: contract.id,
          undeliveredQtyKg,
          penaltyKobo,
          strandedLotId,
          remarketedListingId
        },
        actorId
      );
      await this.audit?.record({
        actorId,
        action: 'marketplace.offtake.default_remedy',
        entityType: 'offtake_contract',
        entityId: contract.id,
        metadata: { undeliveredQtyKg, penaltyKobo, strandedLotId, remarketedListingId }
      });
    } catch (error) {
      this.logger.error(
        `V-35 default remedy failed for contract ${contract.id} (penalty journal key ` +
          `${defaultPenaltyLedgerKey(contract.id)}): ${(error as Error)?.message ?? error}`
      );
      await this.audit?.record({
        actorId,
        action: 'marketplace.offtake.default_remedy_failed',
        entityType: 'offtake_contract',
        entityId: contract.id,
        metadata: { error: (error as Error)?.message ?? String(error) }
      });
    }
  }

  private async buildView(contract: OfftakeContract): Promise<OfftakeContractView> {
    const today = todayIso();
    const milestones = (await this.contracts.listMilestones(contract.id)).map((milestone) => ({
      ...milestone,
      // View-time derivation only: a milestone is missed once the clock
      // passes its due date; the persisted status moves via the sweep.
      status: effectiveMilestoneStatus(milestone, today)
    }));
    const deliveries = await this.contracts.listDeliveries(contract.id);
    return { contract, milestones, deliveries };
  }
}
