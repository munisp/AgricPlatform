import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit
} from '@nestjs/common';
import { FLOOD_SEVERITY_RANKS, type FloodSeverityRank, type User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService, type DomainEvent } from '../../core/domain-events.service.js';
import {
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  VOUCHER_COVER_REPOSITORY,
  VOUCHER_PROGRAMME_RIDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { SubsidyProgrammeRepository } from '../../database/repositories/input-vouchers.repository.js';
import type {
  ParametricProductRepository,
  VoucherCoverRecord,
  VoucherCoverRepository,
  VoucherCoverCriteria,
  VoucherProgrammeRiderRecord,
  VoucherProgrammeRiderRepository
} from '../../database/repositories/insurance.repository.js';
import { computePremiumKobo, MAX_SUM_INSURED_KOBO, MIN_SUM_INSURED_KOBO } from './premium.js';

export interface DefineRiderInput {
  /** Catalog product code (trigger type source), e.g. 'NG-RAIN-WET-26'. */
  productCode: string;
  sumInsuredKobo: number;
  /** Defaults to the catalog product's rate; bounded 1–10000 bps. */
  premiumRateBps?: number;
  /** Pricing flood band captured at definition time (default 'none'). */
  floodBand?: FloodSeverityRank;
}

export interface DefineRiderResult {
  rider: VoucherProgrammeRiderRecord;
  /** Deterministic per-voucher premium preview from the rate card. */
  premiumPreviewKobo: number;
  replayed: boolean;
}

/**
 * Stage 27 (Insurance-in-the-Bag): sponsor-defined insurance riders on
 * subsidy programmes, farmer-facing cover reads, and the lifecycle
 * projector that mirrors policy events onto voucher covers.
 *
 * Money doctrine: this service NEVER posts to the ledger. The premium
 * debit rides the voucher-redemption ledger entry in InputVouchersService
 * (envelope split, one atomic posting); the payout leg flows through the
 * existing insurance policy lifecycle (evaluateTriggers → proposePayout →
 * confirmPayout) whose stub execution is fail-closed in production — this
 * projector only observes its events, it does not weaken those gates.
 *
 * Projector discipline: listeners catch their own errors (a projection
 * failure must never break the insurance fan-out) and transitions are CAS
 * + idempotent, so duplicate event delivery replays as a no-op.
 */
@Injectable()
export class VoucherCoversService implements OnModuleInit {
  private readonly logger = new Logger(VoucherCoversService.name);

  constructor(
    @Inject(VOUCHER_PROGRAMME_RIDER_REPOSITORY) private readonly riders: VoucherProgrammeRiderRepository,
    @Inject(VOUCHER_COVER_REPOSITORY) private readonly covers: VoucherCoverRepository,
    @Inject(PARAMETRIC_PRODUCT_REPOSITORY) private readonly products: ParametricProductRepository,
    @Inject(INPUT_VOUCHER_PROGRAMME_REPOSITORY) private readonly programmes: SubsidyProgrammeRepository,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly telemetry?: TelemetryService
  ) {}

  onModuleInit(): void {
    this.events.on('insurance.trigger.raised', (event) => void this.projectTriggered(event));
    this.events.on('insurance.payout.paid', (event) => void this.projectPaid(event));
  }

  // ---------------------------------------------------------------- riders

  /**
   * Defines (or idempotently re-defines) the programme's insurance rider.
   * The premium preview reuses the deterministic rate card with its
   * ₦1k–₦1M sum-insured bounds. Re-defining with DIFFERENT terms is
   * rejected (409 RIDER_LOCKED) once any cover has been bound under the
   * programme — money terms cannot change under live covers (same
   * immutable-snapshot doctrine as seasonal schedules).
   */
  async defineRider(programmeId: string, input: DefineRiderInput, actorId: string): Promise<DefineRiderResult> {
    const programme = await this.programmes.findById(programmeId);
    if (!programme) {
      throw new NotFoundException(`Programme '${programmeId}' not found`);
    }
    if (!input.productCode?.trim()) {
      throw new BadRequestException('productCode is required');
    }
    const product = await this.products.findOne({ code: input.productCode.trim() });
    if (!product) {
      throw new BadRequestException(
        `Unknown insurance product '${input.productCode}' — riders reference the seeded parametric catalog`
      );
    }
    if (
      !Number.isSafeInteger(input.sumInsuredKobo) ||
      input.sumInsuredKobo < MIN_SUM_INSURED_KOBO ||
      input.sumInsuredKobo > MAX_SUM_INSURED_KOBO
    ) {
      throw new BadRequestException(
        `sumInsuredKobo must be between ${MIN_SUM_INSURED_KOBO} and ${MAX_SUM_INSURED_KOBO} kobo (rate-card bounds)`
      );
    }
    const premiumRateBps = input.premiumRateBps ?? product.premiumRateBps;
    if (!Number.isSafeInteger(premiumRateBps) || premiumRateBps <= 0 || premiumRateBps > 10_000) {
      throw new BadRequestException('premiumRateBps must be an integer between 1 and 10000');
    }
    const floodBand: FloodSeverityRank = input.floodBand ?? 'none';
    if (!FLOOD_SEVERITY_RANKS.includes(floodBand)) {
      throw new BadRequestException(`floodBand must be one of ${FLOOD_SEVERITY_RANKS.join(', ')}`);
    }
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: input.sumInsuredKobo,
      premiumRateBps,
      floodBand
    });
    const now = new Date().toISOString();
    const existing = await this.riders.findByProgrammeId(programmeId);
    if (existing) {
      const identical =
        existing.productCode === product.code &&
        existing.sumInsuredKobo === input.sumInsuredKobo &&
        existing.premiumRateBps === premiumRateBps &&
        existing.floodBand === floodBand;
      if (identical) {
        return { rider: existing, premiumPreviewKobo: premiumKobo, replayed: true };
      }
      const bound = await this.covers.find({ programmeId });
      if (bound.length > 0) {
        throw new ConflictException(
          `RIDER_LOCKED: programme '${programmeId}' already has ${bound.length} bound cover(s) — rider terms cannot change under live covers`
        );
      }
      const updated = await this.riders.update({
        ...existing,
        productCode: product.code,
        sumInsuredKobo: input.sumInsuredKobo,
        premiumRateBps,
        floodBand,
        updatedAt: now
      });
      await this.publishQuoted(updated, premiumKobo, actorId);
      return { rider: updated, premiumPreviewKobo: premiumKobo, replayed: false };
    }
    const rider = await this.riders.create({
      id: newId('ivrider'),
      programmeId,
      productCode: product.code,
      sumInsuredKobo: input.sumInsuredKobo,
      premiumRateBps,
      floodBand,
      status: 'active',
      createdBy: actorId,
      createdAt: now,
      updatedAt: now
    });
    await this.publishQuoted(rider, premiumKobo, actorId);
    await this.audit?.record({
      actorId,
      action: 'insurance.voucher_rider.defined',
      entityType: 'insurance_programme_riders',
      entityId: rider.id,
      metadata: { programmeId, productCode: rider.productCode, sumInsuredKobo: rider.sumInsuredKobo, premiumRateBps, floodBand }
    });
    return { rider, premiumPreviewKobo: premiumKobo, replayed: false };
  }

  /** Programme-level quote event: the deterministic premium the rider prices at. */
  private async publishQuoted(
    rider: VoucherProgrammeRiderRecord,
    premiumKobo: number,
    actorId: string
  ): Promise<void> {
    await this.events.publish(
      'insurance.voucher_cover.quoted',
      {
        riderId: rider.id,
        programmeId: rider.programmeId,
        productCode: rider.productCode,
        sumInsuredKobo: rider.sumInsuredKobo,
        premiumRateBps: rider.premiumRateBps,
        floodBand: rider.floodBand,
        premiumKobo
      },
      actorId
    );
    this.telemetry?.increment('insurance.voucher_riders_total', 1, {
      programme_id: rider.programmeId,
      trigger_type: rider.productCode
    });
  }

  async getRider(programmeId: string): Promise<VoucherProgrammeRiderRecord> {
    const programme = await this.programmes.findById(programmeId);
    if (!programme) {
      throw new NotFoundException(`Programme '${programmeId}' not found`);
    }
    const rider = await this.riders.findByProgrammeId(programmeId);
    if (!rider) {
      throw new NotFoundException(`Programme '${programmeId}' has no insurance rider`);
    }
    return rider;
  }

  // ---------------------------------------------------------------- covers

  /** Farmer-facing cover status (farmer themself, or an authorised reviewer). */
  async getCover(id: string, actor: User): Promise<VoucherCoverRecord> {
    const cover = await this.covers.findById(id);
    if (!cover) {
      throw new NotFoundException(`Voucher cover '${id}' not found`);
    }
    const reviewer = (['admin', 'regulator', 'donor'] as const).some((role) => actor.roles.includes(role));
    if (cover.farmerId !== actor.id && !reviewer) {
      throw new ForbiddenException('Only the covered farmer or an authorised reviewer can read this cover');
    }
    return cover;
  }

  listCovers(criteria: VoucherCoverCriteria): Promise<VoucherCoverRecord[]> {
    return this.covers.find(criteria);
  }

  // ------------------------------------------------------------- projector

  /**
   * bound → triggered when the underlying policy's trigger fires. Idempotent:
   * a duplicate event finds the cover already triggered and no-ops; a cover
   * for another lifecycle state is left untouched.
   */
  private async projectTriggered(event: DomainEvent): Promise<void> {
    try {
      const payload = event.payload as { policyId?: string; triggerEventId?: string; payoutKobo?: number };
      if (!payload.policyId) {
        return;
      }
      const cover = (await this.covers.find({ policyId: payload.policyId }))[0];
      if (!cover || cover.status !== 'bound') {
        return;
      }
      const updated = await this.covers.updateExpected(
        cover.id,
        { status: 'triggered', updatedAt: new Date().toISOString() },
        { status: 'bound' }
      );
      await this.events.publish(
        'insurance.voucher_cover.triggered',
        {
          coverId: updated.id,
          voucherId: updated.voucherId,
          policyId: updated.policyId,
          programmeId: updated.programmeId,
          triggerEventId: payload.triggerEventId,
          payoutKobo: payload.payoutKobo
        },
        event.actorId
      );
    } catch (error) {
      // Projection failures must never break the insurance event fan-out;
      // the next evaluation replay re-delivers and re-projects.
      this.logger.warn(`voucher-cover trigger projection failed: ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * triggered → paid when the insurer payout is confirmed. The confirmation
   * itself is externally gated (insurer MOU; stub execution is 503 in
   * production) — this projector only mirrors the committed outcome.
   */
  private async projectPaid(event: DomainEvent): Promise<void> {
    try {
      const payload = event.payload as { policyId?: string; payoutId?: string; amountKobo?: number };
      if (!payload.policyId) {
        return;
      }
      const cover = (await this.covers.find({ policyId: payload.policyId }))[0];
      if (!cover || cover.status !== 'triggered') {
        return;
      }
      const updated = await this.covers.updateExpected(
        cover.id,
        { status: 'paid', updatedAt: new Date().toISOString() },
        { status: 'triggered' }
      );
      await this.events.publish(
        'insurance.voucher_cover.payout_posted',
        {
          coverId: updated.id,
          voucherId: updated.voucherId,
          policyId: updated.policyId,
          programmeId: updated.programmeId,
          payoutId: payload.payoutId,
          amountKobo: payload.amountKobo
        },
        event.actorId
      );
    } catch (error) {
      this.logger.warn(`voucher-cover payout projection failed: ${(error as Error)?.message ?? error}`);
    }
  }
}
