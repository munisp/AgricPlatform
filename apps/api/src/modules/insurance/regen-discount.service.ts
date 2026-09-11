import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import type { FarmPlot, User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  CARBON_EVIDENCE_REPOSITORY,
  CARBON_PLOT_REPOSITORY,
  REGEN_DISCOUNT_RATE_CARD_REPOSITORY,
  REGEN_DISCOUNT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  RegenDiscountRateCardRecord,
  RegenDiscountRateCardRepository,
  RegenDiscountRecord,
  RegenDiscountRepository,
  RegenEvidenceBasis
} from '../../database/repositories/insurance.repository.js';
import type {
  CarbonEvidenceRecord,
  CarbonEvidenceRepository,
  CarbonPlotRepository
} from '../../database/repositories/vsla-carbon.repository.js';
import { H3Service } from '../geo/h3.service.js';
import { MAX_REGEN_DISCOUNT_BPS } from './premium.js';

/** Rollout flag for the regen discount (default OFF, fail-closed). */
export const REGEN_DISCOUNT_FLAG = 'regen-discount';

export type RegenIneligibilityReason =
  | 'flag_off'
  | 'rate_card_unset'
  | 'no_attestation'
  | 'stale_attestation';

export interface RegenQuoteEligibility {
  eligible: boolean;
  reason?: RegenIneligibilityReason;
  /** Present when eligible: the bounded discount from the current rate card. */
  discountBps?: number;
  /** Present when eligible: the rate-card version that prices the policy. */
  rateCardVersion?: number;
  /** Present when eligible: the vsla-carbon evidence row (the evidence FK). */
  attestationId?: string;
  evidenceBasis?: RegenEvidenceBasis;
}

/**
 * Stage 27 (Regen Discount, innovation 12): carbon-MRV-verified premium
 * discount on parametric policies.
 *
 * Eligibility doctrine (fail-closed honesty): a plot qualifies only when a
 * RECORDED vsla-carbon seasonal evidence attestation exists for the SAME
 * land and the policy season — a carbon plot registered to the policy
 * farmer whose app-layer H3 res-9 index matches the insured plot centroid,
 * with an evidence row (human/enumerator attestation, optionally
 * NDVI-linked) for that exact season. A satellite score is NEVER fabricated
 * or assumed. Evidence from a different season is stale: the discount is
 * refused and `insurance.regen_discount.rejected_stale_evidence` is
 * published. evidence_basis is 'live' only when the attestation carries a
 * live-provider NDVI linkage; human-only and stub-NDVI attestations are
 * 'estimate' (estimate-only carbon figures stay estimate-only).
 *
 * Money doctrine: this service never posts to the ledger. It only adjusts
 * the deterministic premium at quote time (premium.ts pure function,
 * floor-capped at ₦1k) and records the exactly-once-per-policy discount
 * row with its evidence FK and the rate-card version that priced it.
 */
@Injectable()
export class RegenDiscountService {
  constructor(
    @Inject(REGEN_DISCOUNT_RATE_CARD_REPOSITORY)
    private readonly rateCard: RegenDiscountRateCardRepository,
    @Inject(REGEN_DISCOUNT_REPOSITORY)
    private readonly discounts: RegenDiscountRepository,
    @Inject(CARBON_PLOT_REPOSITORY) private readonly carbonPlots: CarbonPlotRepository,
    @Inject(CARBON_EVIDENCE_REPOSITORY) private readonly carbonEvidence: CarbonEvidenceRepository,
    private readonly h3: H3Service,
    private readonly flags: FeatureFlagsService,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly telemetry?: TelemetryService
  ) {}

  // ------------------------------------------------------------- rate card

  /** The current (highest-version) rate card, if an admin has set one. */
  currentRateCard(): Promise<RegenDiscountRateCardRecord | undefined> {
    return this.rateCard.current();
  }

  listRateCardVersions(): Promise<RegenDiscountRateCardRecord[]> {
    return this.rateCard.all();
  }

  /**
   * Admin rate-card write: appends a NEW version (append-only, monotonically
   * increasing) so historical policies stay reproducible, and records the
   * change in the hash-chained admin audit log (audit-chained). Bounded
   * 0..MAX_REGEN_DISCOUNT_BPS (0 disables the discount without deleting
   * history).
   */
  async setRateCardDiscount(
    actor: User,
    discountBps: number
  ): Promise<{ record: RegenDiscountRateCardRecord; current: boolean }> {
    if (
      !Number.isSafeInteger(discountBps) ||
      discountBps < 0 ||
      discountBps > MAX_REGEN_DISCOUNT_BPS
    ) {
      throw new BadRequestException(
        `discountBps must be an integer between 0 and ${MAX_REGEN_DISCOUNT_BPS} (bounded rate-card modifier)`
      );
    }
    const current = await this.rateCard.current();
    const record = await this.rateCard.append({
      version: (current?.version ?? 0) + 1,
      discountBps,
      setBy: actor.id,
      createdAt: new Date().toISOString()
    });
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.regen_rate_card.versioned',
      entityType: 'insurance_regen_discount_rate_card',
      entityId: String(record.version),
      metadata: { version: record.version, discountBps: record.discountBps }
    });
    return { record, current: true };
  }

  // ------------------------------------------------------------ eligibility

  /**
   * Resolves whether a quote earns the regen discount. Fail-closed at every
   * step: flag OFF (default) → ineligible; no rate-card version set →
   * ineligible (an admin must opt the programme in explicitly); no recorded
   * same-season attestation for the same land → ineligible. When a matching
   * carbon plot carries evidence ONLY for other seasons, the rejection is
   * published as `insurance.regen_discount.rejected_stale_evidence`.
   */
  async resolveEligibility(input: {
    actor: User;
    plot: FarmPlot;
    season: string;
  }): Promise<RegenQuoteEligibility> {
    const enabled = await this.flags.isEnabled(REGEN_DISCOUNT_FLAG, {
      userId: input.actor.id,
      roles: [...input.actor.roles]
    });
    if (!enabled) {
      return { eligible: false, reason: 'flag_off' };
    }
    const card = await this.rateCard.current();
    if (!card || card.discountBps <= 0) {
      return { eligible: false, reason: 'rate_card_unset' };
    }
    const attestation = await this.findCurrentSeasonAttestation(input.plot, input.season, input.actor.id);
    if (attestation.found) {
      return {
        eligible: true,
        discountBps: card.discountBps,
        rateCardVersion: card.version,
        attestationId: attestation.found.id,
        evidenceBasis: attestation.found.ndviBasis === 'live' ? 'live' : 'estimate'
      };
    }
    if (attestation.stale) {
      await this.events.publish(
        'insurance.regen_discount.rejected_stale_evidence',
        {
          plotId: input.plot.id,
          season: input.season,
          farmerId: input.actor.id,
          staleAttestationId: attestation.stale.id,
          staleSeason: attestation.stale.season
        },
        input.actor.id
      );
      return { eligible: false, reason: 'stale_attestation' };
    }
    return { eligible: false, reason: 'no_attestation' };
  }

  /**
   * Finds the latest recorded attestation for the SAME land in the quote
   * season: a carbon plot registered to the policy farmer whose H3 res-9
   * index equals the insured plot centroid cell, with a carbon-evidence row
   * for that exact season. Returns { stale } when the land matches but its
   * evidence covers only other seasons. Deterministic: latest by
   * (createdAt, id).
   */
  private async findCurrentSeasonAttestation(
    plot: FarmPlot,
    season: string,
    farmerId: string
  ): Promise<{ found?: CarbonEvidenceRecord; stale?: CarbonEvidenceRecord }> {
    const cell = this.h3.cellAt(plot.centroidLat, plot.centroidLong, 9);
    const owned = await this.carbonPlots.find({ ownerUserId: farmerId, status: 'ACTIVE' });
    const sameLand = owned.filter((carbonPlot) => carbonPlot.h3Res9 === cell);
    let stale: CarbonEvidenceRecord | undefined;
    for (const carbonPlot of sameLand) {
      const rows = await this.carbonEvidence.find({ plotId: carbonPlot.id });
      const sorted = [...rows].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      );
      const current = sorted.find((row) => row.season === season);
      if (current) {
        return { found: current };
      }
      stale = stale ?? sorted[0];
    }
    return { stale };
  }

  // ------------------------------------------------------------ application

  /**
   * Records the exactly-once-per-policy discount after the policy row is
   * persisted (UNIQUE policy_id — a re-quote creates a new policy, and a
   * crash-resume adopts the existing row). Publishes
   * `insurance.regen_discount.applied` and increments
   * `insurance.regen_discounts_applied_total` (tenant.id rides the
   * TenantContext automatically).
   */
  async recordDiscount(input: {
    policyId: string;
    plotId: string;
    actorId: string;
    eligibility: RegenQuoteEligibility;
    discountKobo: number;
  }): Promise<RegenDiscountRecord> {
    const existing = await this.discounts.findByPolicyId(input.policyId);
    if (existing) {
      return existing;
    }
    const record = await this.discounts.create({
      id: newId('insregen'),
      policyId: input.policyId,
      plotId: input.plotId,
      attestationId: input.eligibility.attestationId as string,
      discountBps: input.eligibility.discountBps as number,
      discountKobo: input.discountKobo,
      rateCardVersion: input.eligibility.rateCardVersion as number,
      evidenceBasis: input.eligibility.evidenceBasis as RegenEvidenceBasis,
      appliedAt: new Date().toISOString()
    });
    await this.events.publish(
      'insurance.regen_discount.applied',
      {
        discountId: record.id,
        policyId: record.policyId,
        plotId: record.plotId,
        attestationId: record.attestationId,
        discountBps: record.discountBps,
        discountKobo: record.discountKobo,
        rateCardVersion: record.rateCardVersion,
        evidenceBasis: record.evidenceBasis
      },
      input.actorId
    );
    this.telemetry?.increment('insurance.regen_discounts_applied_total', 1, {
      evidence_basis: record.evidenceBasis
    });
    return record;
  }

  /** Discount line for a policy (farmer-facing detail / evidence link). */
  async getDiscountForPolicy(policyId: string): Promise<RegenDiscountRecord> {
    const discount = await this.discounts.findByPolicyId(policyId);
    if (!discount) {
      throw new NotFoundException(`Policy '${policyId}' has no regen discount`);
    }
    return discount;
  }
}
