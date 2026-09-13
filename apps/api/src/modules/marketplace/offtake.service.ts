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
  contractEscrowLiabilityAccountCode,
  coopReceivableAccountCode,
  deliveryAmountKobo,
  deliveryLedgerIdempotencyKey,
  effectiveMilestoneStatus,
  isIsoCalendarDate,
  milestoneStatusAfterDelivery,
  priceWithinBand,
  settlementLedgerIdempotencyKey,
  validateMilestonePlan,
  type OfftakeContract,
  type OfftakeDelivery,
  type OfftakeMilestone
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
  renegotiationRequired: 'marketplace.offtake.renegotiation_required'
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

  /** Credit-side read-only underwriting input (lender/admin; role enforced at the controller). */
  async collateralView(contractId: string): Promise<OfftakeCollateralView> {
    const contract = await this.contracts.getById(contractId);
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
    return this.commitDelivery(contract, milestone, delivery, entry, caller.id);
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
   * The atomic core of the delivery saga. PostgreSQL: ONE transaction via
   * recordDeliveryTx (claim + accumulation CAS + journal + fulfilment CAS +
   * outbox). In-memory: the idempotency-key claim is the arbiter and the
   * journal posts through LedgerService (idempotency-keyed) before the
   * milestone state finalizes.
   */
  private async commitDelivery(
    contract: OfftakeContract,
    milestone: OfftakeMilestone,
    delivery: OfftakeDelivery,
    entry: LedgerJournalEntry,
    actorId: string
  ): Promise<OfftakeDeliveryResult> {
    await this.ensureEscrowAccounts(contract);
    if (this.contracts.transactionalDelivery && this.contracts.recordDeliveryTx) {
      let committed: DomainEvent[] = [];
      const txInput: OfftakeDeliveryTxInput = {
        contractId: contract.id,
        milestoneId: milestone.id,
        delivery,
        milestonePatch: {
          deliveredQtyKg: milestone.deliveredQtyKg + delivery.qtyKg,
          status: milestoneStatusAfterDelivery(
            milestone.deliveredQtyKg + delivery.qtyKg,
            milestone.qtyKg
          ),
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
    const claimed = await this.contracts.addDelivery(delivery); // 409 on key replay
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
    const deliveredQtyKg = milestone.deliveredQtyKg + delivery.qtyKg;
    const updatedMilestone = await this.contracts.updateMilestoneExpected(
      milestone.id,
      {
        deliveredQtyKg,
        status: milestoneStatusAfterDelivery(deliveredQtyKg, milestone.qtyKg),
        linkedLotId: delivery.lotId,
        invoiceId: delivery.invoiceId,
        escrowId: delivery.escrowId
      },
      { status: milestone.status, deliveredQtyKg: milestone.deliveredQtyKg }
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
    const milestone = await this.contracts.milestoneByEscrowId(payload.escrowId);
    if (!milestone) {
      return; // not an offtake escrow
    }
    const deliveries = await this.contracts.listDeliveries(milestone.contractId);
    const delivery = deliveries.find((candidate) => candidate.escrowId === payload.escrowId);
    if (!delivery) {
      return;
    }
    const contract = await this.contracts.getById(milestone.contractId);
    await this.ensureEscrowAccounts(contract);
    await this.ledger.postEntry(
      {
        idempotencyKey: settlementLedgerIdempotencyKey(payload.escrowId),
        referenceType: 'offtake_settlement',
        referenceId: payload.escrowId,
        description: `Offtake delivery settlement (escrow ${payload.escrowId} released)`,
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
      }
    }
    return { missedMilestones, defaultedContracts };
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
