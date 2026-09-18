import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  ApiListResponse,
  ParametricPayout,
  ParametricPolicy,
  ParametricProduct,
  ParametricQuote,
  ParametricTriggerEvent,
  ParametricTriggerEvidence,
  User
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  FARM_PLOT_REPOSITORY,
  PARAMETRIC_PAYOUT_REPOSITORY,
  PARAMETRIC_POLICY_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  PARAMETRIC_TRIGGER_EVENT_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type {
  ParametricPayoutRepository,
  ParametricPolicyRepository,
  ParametricProductRepository,
  ParametricTriggerEventRepository
} from '../../database/repositories/insurance.repository.js';
import {
  createFloodRiskDriver,
  ProviderConfigError as FloodConfigError,
  ProviderHttpError as FloodHttpError,
  ProviderRequestError as FloodRequestError,
  type FloodRiskDriver
} from '../geo-intel/flood-risk.drivers.js';
import { H3Service } from '../geo/h3.service.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  computePremiumKobo,
  MAX_SUM_INSURED_KOBO,
  MIN_SUM_INSURED_KOBO
} from './premium.js';
import {
  aggregateHeatDays,
  aggregateRainfallMm,
  computeEvidenceFingerprint,
  evaluateTrigger,
  floodBandForRank,
  floodSeverityRank,
  payoutBandFor,
  payoutKoboFor
} from './trigger-engine.js';
import {
  createWeatherProvider,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  type InsuranceWeatherProvider
} from './weather.provider.js';
import { RegenDiscountService, type RegenQuoteEligibility } from './regen-discount.service.js';
import type { RegenDiscountRecord } from '../../database/repositories/insurance.repository.js';

/** Ledger account codes for the stub payout rail. */
export const INSURER_CLAIMS_EXPENSE_ACCOUNT = 'insurer:claims_expense';
export const INSURER_CLAIMS_PAYABLE_ACCOUNT = 'insurer:claims_payable';

/**
 * V-42: window in which a farmer may dispute a proposed payout or appeal a
 * rejection, counted from proposedAt / rejectedAt respectively.
 */
export const PAYOUT_APPEAL_WINDOW_DAYS = 30;
const APPEAL_WINDOW_MS = PAYOUT_APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Corrected observation submitted with a dispute/appeal re-evaluation (V-42). */
export interface CorrectedEvidenceInput {
  /** Replacement aggregate observation (mm of rain, heat-day count, flood rank). */
  observedValue: number;
  dailyValues?: number[];
  /** Provenance note recorded on the audit trail (who corrected what, why). */
  notes?: string;
}

export interface ExGratiaPayoutInput {
  policyId: string;
  amountKobo: number;
  /** Why the parametric trigger missed a real loss (basis-risk narrative). */
  reason: string;
}

/** Fixed catalog seed timestamp — deterministic across re-seeds. */
const CATALOG_SEEDED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Seeded product catalog (wave-insurance). Seeding goes through the
 * repository upsert (keyed by code), NEVER migration data, so re-applying
 * migrations cannot resurrect edited products and local/dev/pg stays
 * identical.
 */
export const INSURANCE_PRODUCT_CATALOG: readonly Omit<ParametricProduct, 'id'>[] = [
  {
    code: 'NG-RAIN-WET-26',
    name: 'Wet-season rainfall deficit cover',
    description:
      'Pays out when total rainfall over a 30-day window of the 2026 wet season falls to or below 40 mm for the plot h3 cell.',
    peril: 'RAINFALL_DEFICIT',
    trigger: {
      metric: 'rainfall_mm',
      operator: 'lte',
      threshold: 40,
      h3Resolution: 7,
      observationWindowDays: 30,
      season: '2026-wet'
    },
    payoutTable: [
      { minRatio: 0.5, payoutPercent: 100 },
      { minRatio: 0.25, payoutPercent: 60 },
      { minRatio: 0, payoutPercent: 25 }
    ],
    premiumRateBps: 800,
    createdAt: CATALOG_SEEDED_AT
  },
  {
    code: 'NG-FLOOD-26',
    name: 'Flood cover (high severity)',
    description:
      'Pays out when the assessed flood severity for the plot reaches at least the "high" band during the 2026 wet season.',
    peril: 'FLOOD',
    trigger: {
      metric: 'flood_rank',
      operator: 'gte',
      threshold: 3,
      h3Resolution: 7,
      observationWindowDays: 90,
      season: '2026-wet'
    },
    payoutTable: [
      { minRatio: 0.25, payoutPercent: 100 },
      { minRatio: 0, payoutPercent: 50 }
    ],
    premiumRateBps: 1_000,
    createdAt: CATALOG_SEEDED_AT
  },
  {
    code: 'NG-HEAT-DRY-26',
    name: 'Dry-season heat stress cover',
    description:
      'Pays out when at least 10 heat days (daily maximum ≥ 38 °C) are observed in a 45-day window of the 2026 dry season.',
    peril: 'HEAT_STRESS',
    trigger: {
      metric: 'heat_days',
      operator: 'gte',
      threshold: 10,
      h3Resolution: 7,
      observationWindowDays: 45,
      season: '2026-dry'
    },
    payoutTable: [
      { minRatio: 0.5, payoutPercent: 100 },
      { minRatio: 0.2, payoutPercent: 60 },
      { minRatio: 0, payoutPercent: 25 }
    ],
    premiumRateBps: 600,
    createdAt: CATALOG_SEEDED_AT
  }
];

export interface QuoteInput {
  productCode: string;
  plotId: string;
  season: string;
  sumInsuredKobo: number;
}

export interface EvaluationCellReport {
  policyId: string;
  h3Cell: string;
  status: 'triggered' | 'clear' | 'duplicate' | 'unavailable' | 'failed';
}

export interface TriggerEvaluationReport {
  evaluated: number;
  triggered: number;
  payoutsProposed: number;
  /** Unchanged evidence fingerprint — replayed, no new event. */
  duplicates: number;
  /** Live provider configured but unreachable — fail-closed, NO event. */
  unavailable: number;
  failed: number;
  cells: EvaluationCellReport[];
  evaluatedAt: string;
}

export interface InsurerPortfolio {
  policiesByStatus: Record<string, number>;
  totalSumInsuredKobo: number;
  totalPremiumKobo: number;
  payoutsByStatus: Record<string, number>;
  totalPayoutKobo: number;
  triggerEventCount: number;
  /**
   * V-43 solvency tracking: payouts whose settlement leg is ledger-booked
   * but NOT rail-confirmed ('paid' awaiting 'settled') — the insurer's live
   * unsettled obligation to farmers.
   */
  unsettledPayoutKobo: number;
  /**
   * V-43: balance of the insurer claims-payable ledger account (credit
   * balance = outstanding claim obligations booked but not yet settled).
   */
  claimsPayableBalanceKobo: number;
}

function requireAdmin(actor: User): void {
  if (!actor.roles.includes('admin')) {
    throw new ForbiddenException('Only administrators may run trigger evaluation and payout ops');
  }
}

function isWeatherProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderConfigError ||
    error instanceof ProviderHttpError ||
    error instanceof ProviderRequestError ||
    error instanceof FloodConfigError ||
    error instanceof FloodHttpError ||
    error instanceof FloodRequestError
  );
}

/**
 * Parametric insurance rail (wave-insurance). Orchestrates the product
 * catalog, policy lifecycle, deterministic trigger evaluation and stub-mode
 * payout proposals. Fail-closed doctrine mirrors geo-intel: a configured
 * live weather/flood provider that is unreachable marks evaluation cells
 * 'unavailable' and the evaluation endpoint answers 503 — the stub is never
 * silently substituted. Payouts settle through the double-entry ledger in
 * STUB execution mode; real disbursement is gated externally (insurer MOU +
 * payment rail activation, docs/parametric-insurance.md).
 */
@Injectable()
export class InsuranceService {
  private weatherProvider: InsuranceWeatherProvider | undefined;
  private floodDriver: FloodRiskDriver | undefined;

  constructor(
    @Inject(PARAMETRIC_PRODUCT_REPOSITORY)
    private readonly products: ParametricProductRepository,
    @Inject(PARAMETRIC_POLICY_REPOSITORY)
    private readonly policies: ParametricPolicyRepository,
    @Inject(PARAMETRIC_TRIGGER_EVENT_REPOSITORY)
    private readonly triggerEvents: ParametricTriggerEventRepository,
    @Inject(PARAMETRIC_PAYOUT_REPOSITORY)
    private readonly payouts: ParametricPayoutRepository,
    @Inject(FARM_PLOT_REPOSITORY) private readonly plots: FarmPlotRepository,
    private readonly h3: H3Service,
    private readonly ledger: LedgerService,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit?: AuditService,
    // Stage 27 (Regen Discount): optional so hand-rolled unit tests can
    // construct the service without the discount collaborator — the running
    // app always resolves it from the InsuranceModule providers.
    @Optional() private readonly regen?: RegenDiscountService,
    @Optional() private readonly telemetry?: TelemetryService
  ) {}

  /** Visible for tests: rebuild lazily-resolved providers after env changes. */
  resetProvidersForTests(): void {
    this.weatherProvider = undefined;
    this.floodDriver = undefined;
  }

  private resolveWeatherProvider(): InsuranceWeatherProvider {
    if (!this.weatherProvider) {
      this.weatherProvider = createWeatherProvider();
    }
    return this.weatherProvider;
  }

  private resolveFloodDriver(): FloodRiskDriver {
    if (!this.floodDriver) {
      this.floodDriver = createFloodRiskDriver();
    }
    return this.floodDriver;
  }

  /** Idempotent catalog seed through the repository upsert (never migration data). */
  async ensureCatalogSeeded(): Promise<void> {
    for (const product of INSURANCE_PRODUCT_CATALOG) {
      const existing = await this.products.findOne({ code: product.code });
      await this.products.upsert({ id: existing?.id ?? newId('insprod'), ...product });
    }
  }

  async listProducts(): Promise<ParametricProduct[]> {
    await this.ensureCatalogSeeded();
    return this.products.all();
  }

  /**
   * Quotes and persists a QUOTED policy. The premium is the deterministic
   * rate card (sum insured × peril rate × flood-band modifier); the flood
   * band comes from the geo-intel flood port and fails closed (503) when a
   * configured live flood sidecar is unreachable.
   *
   * Stage 27 (Regen Discount): when the `regen-discount` flag is on and the
   * plot carries a current-season recorded carbon attestation, the bounded,
   * versioned regen discount applies inside the same deterministic premium
   * computation (floor-capped at ₦1k, byte-stable), and the discount row is
   * recorded with its evidence FK + rate-card version.
   */
  async quote(
    actor: User,
    input: QuoteInput
  ): Promise<{ quote: ParametricQuote; policy: ParametricPolicy; regenDiscount?: RegenDiscountRecord }> {
    await this.ensureCatalogSeeded();
    if (!Number.isSafeInteger(input.sumInsuredKobo)) {
      throw new BadRequestException('sumInsuredKobo must be an integer kobo amount');
    }
    if (
      input.sumInsuredKobo < MIN_SUM_INSURED_KOBO ||
      input.sumInsuredKobo > MAX_SUM_INSURED_KOBO
    ) {
      throw new BadRequestException(
        `sumInsuredKobo must be between ${MIN_SUM_INSURED_KOBO} and ${MAX_SUM_INSURED_KOBO} kobo`
      );
    }
    const product = await this.products.findOne({ code: input.productCode });
    if (!product) {
      throw new NotFoundException(`Insurance product '${input.productCode}' not found`);
    }
    if (input.season !== product.trigger.season) {
      throw new BadRequestException(
        `Product '${product.code}' covers season '${product.trigger.season}', not '${input.season}'`
      );
    }
    const plot = await this.plots.findById(input.plotId);
    if (!plot) {
      throw new NotFoundException(`Plot '${input.plotId}' not found`);
    }
    if (plot.ownerUserId !== actor.id) {
      throw new ForbiddenException('Only the plot owner can insure a plot');
    }
    const driver = this.resolveFloodDriver();
    const pricingBasis: 'stub' | 'live' = driver.name === 'http' ? 'live' : 'stub';
    let severity: string;
    try {
      const assessment = await driver.assess({
        latitude: plot.centroidLat,
        longitude: plot.centroidLong
      });
      severity = assessment.severity;
    } catch (error) {
      if (isWeatherProviderError(error)) {
        throw new ServiceUnavailableException(
          'Flood-risk pricing input is unavailable: the configured flood-ml sidecar could not be reached.'
        );
      }
      throw error;
    }
    const floodBand = floodBandForRank(floodSeverityRank(severity));
    // Stage 27 (Regen Discount): eligibility is resolved BEFORE pricing so
    // the discount rides the same deterministic premium computation. Flag
    // OFF (default) → ineligible, quote behaves exactly as before.
    const regenEligibility: RegenQuoteEligibility = this.regen
      ? await this.regen.resolveEligibility({ actor, plot, season: input.season })
      : { eligible: false };
    const { premiumKobo, floodModifierBps, regenDiscountKobo } = await (
      this.telemetry ?? new TelemetryService()
    ).withSpan(
      'insurance.premium.compute',
      { product_code: product.code, regen_eligible: regenEligibility.eligible },
      async () =>
        computePremiumKobo({
          sumInsuredKobo: input.sumInsuredKobo,
          premiumRateBps: product.premiumRateBps,
          floodBand,
          ...(regenEligibility.eligible && regenEligibility.discountBps !== undefined
            ? { regenDiscountBps: regenEligibility.discountBps }
            : {})
        })
    );
    const now = new Date().toISOString();
    const policy: ParametricPolicy = {
      id: newId('inspol'),
      farmerUserId: actor.id,
      plotId: plot.id,
      productId: product.id,
      productCode: product.code,
      season: input.season,
      sumInsuredKobo: input.sumInsuredKobo,
      premiumKobo,
      floodBand,
      pricingBasis,
      status: 'quoted',
      createdAt: now,
      updatedAt: now
    };
    await this.policies.create(policy);
    // Stage 27: record the exactly-once-per-policy discount row only when a
    // real (non-floor-capped-to-zero) discount was priced in — the row
    // carries the evidence FK, the rate-card version and the honest
    // evidence-basis badge so the policy documents estimate-only evidence.
    let regenDiscount: RegenDiscountRecord | undefined;
    if (this.regen && regenEligibility.eligible && regenDiscountKobo > 0) {
      regenDiscount = await this.regen.recordDiscount({
        policyId: policy.id,
        plotId: plot.id,
        actorId: actor.id,
        eligibility: regenEligibility,
        discountKobo: regenDiscountKobo
      });
    }
    const quote: ParametricQuote = {
      productCode: product.code,
      season: input.season,
      sumInsuredKobo: input.sumInsuredKobo,
      premiumRateBps: product.premiumRateBps,
      floodBand,
      floodModifierBps,
      premiumKobo,
      pricingBasis
    };
    return { quote, policy, ...(regenDiscount ? { regenDiscount } : {}) };
  }

  /** QUOTED → ACTIVE (owner only). Illegal transitions surface 409. */
  async issue(actor: User, policyId: string): Promise<ParametricPolicy> {
    const policy = await this.getPolicy(policyId);
    if (policy.farmerUserId !== actor.id) {
      throw new ForbiddenException('Only the policy holder can issue the policy');
    }
    if (policy.status !== 'quoted') {
      throw new ConflictException(
        `Only quoted policies can be issued (policy is '${policy.status}')`
      );
    }
    const issued = await this.policies.transition(policy.id, 'quoted', {
      status: 'active',
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'insurance.policy.issued',
      { policyId: issued.id, productCode: issued.productCode, season: issued.season },
      actor.id
    );
    return issued;
  }

  /** ACTIVE → EXPIRED (admin). Illegal transitions surface 409. */
  async expire(actor: User, policyId: string): Promise<ParametricPolicy> {
    requireAdmin(actor);
    const policy = await this.getPolicy(policyId);
    if (policy.status !== 'active') {
      throw new ConflictException(
        `Only active policies can expire (policy is '${policy.status}')`
      );
    }
    return this.policies.transition(policy.id, 'active', {
      status: 'expired',
      updatedAt: new Date().toISOString()
    });
  }

  async getPolicy(policyId: string): Promise<ParametricPolicy> {
    const policy = await this.policies.findById(policyId);
    if (!policy) {
      throw new NotFoundException(`Insurance policy '${policyId}' not found`);
    }
    return policy;
  }

  myPolicies(actor: User): Promise<ParametricPolicy[]> {
    return this.policies.find({ farmerUserId: actor.id });
  }

  myTriggerEvents(actor: User): Promise<ParametricTriggerEvent[]> {
    return this.triggerEvents.find({ farmerUserId: actor.id });
  }

  myPayouts(actor: User): Promise<ParametricPayout[]> {
    return this.payouts.find({ farmerUserId: actor.id });
  }

  /**
   * Admin directory of trigger events — paginated (V-72): the unbounded
   * all() scan serialized whole tables into one response.
   */
  listTriggerEvents(
    actor: User,
    page = 1,
    pageSize = 20
  ): Promise<ApiListResponse<ParametricTriggerEvent>> {
    requireAdmin(actor);
    return this.triggerEvents.searchPage({}, page, pageSize);
  }

  /** Admin payout ledger — paginated (V-72). */
  listPayouts(
    actor: User,
    page = 1,
    pageSize = 20
  ): Promise<ApiListResponse<ParametricPayout>> {
    requireAdmin(actor);
    return this.payouts.searchPage({}, page, pageSize);
  }

  /**
   * Deterministic batch trigger evaluation over ACTIVE policies
   * (admin/cron-style). For each policy the observed value for the plot h3
   * cell is compared to the product trigger; breaches persist a
   * TriggerEvent with the full evidence payload and propose a payout
   * through the ledger (stub execution). Idempotent: the evidence
   * fingerprint makes re-runs with unchanged inputs no-ops. Fail-closed:
   * when a configured live provider is unreachable the affected cells are
   * marked 'unavailable' and the run answers 503.
   */
  async evaluateTriggers(actor: User): Promise<TriggerEvaluationReport> {
    requireAdmin(actor);
    await this.ensureCatalogSeeded();
    const report: TriggerEvaluationReport = {
      evaluated: 0,
      triggered: 0,
      payoutsProposed: 0,
      duplicates: 0,
      unavailable: 0,
      failed: 0,
      cells: [],
      evaluatedAt: new Date().toISOString()
    };
    const active = await this.policies.find({ status: 'active' });
    for (const policy of active) {
      const cell = await this.evaluatePolicy(policy, report, actor);
      report.cells.push(cell);
    }
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.triggers.evaluated',
      entityType: 'insurance_trigger_events',
      entityId: 'batch',
      metadata: {
        evaluated: report.evaluated,
        triggered: report.triggered,
        payoutsProposed: report.payoutsProposed,
        duplicates: report.duplicates,
        unavailable: report.unavailable,
        failed: report.failed
      }
    });
    if (report.unavailable > 0) {
      throw new ServiceUnavailableException({
        message:
          'Trigger evaluation is incomplete: the configured live weather/flood provider could not be reached. ' +
          'Affected cells were marked unavailable and NO trigger events were fabricated for them.',
        report
      });
    }
    return report;
  }

  private async evaluatePolicy(
    policy: ParametricPolicy,
    report: TriggerEvaluationReport,
    actor: User
  ): Promise<EvaluationCellReport> {
    report.evaluated += 1;
    const fallbackCell: EvaluationCellReport = {
      policyId: policy.id,
      h3Cell: 'unknown',
      status: 'failed'
    };
    try {
      const product = await this.products.findById(policy.productId);
      const plot = await this.plots.findById(policy.plotId);
      if (!product || !plot) {
        report.failed += 1;
        return fallbackCell;
      }
      const h3Cell = this.h3.cellAt(
        plot.centroidLat,
        plot.centroidLong,
        product.trigger.h3Resolution
      );
      fallbackCell.h3Cell = h3Cell;

      // Observation gathering — provider failures fail CLOSED (unavailable).
      let observedValue: number;
      let dailyValues: number[] | undefined;
      const basis = {
        weather: 'unavailable' as 'stub' | 'live' | 'unavailable',
        flood: 'unavailable' as 'stub' | 'live' | 'unavailable'
      };
      try {
        if (product.trigger.metric === 'flood_rank') {
          const driver = this.resolveFloodDriver();
          // Fail closed (mirrors the warehouse deposit basis guard): a stub
          // flood assessment is a fabricated fixture and must never book real
          // ledger payouts in production.
          if (isProduction() && driver.name !== 'http') {
            throw new ServiceUnavailableException(
              'Flood trigger evaluation requires the live flood-ml sidecar in production ' +
                '(FLOOD_ML_DRIVER=http + FLOOD_ML_URL); the deterministic stub driver would ' +
                'book ledger payouts from fabricated data. Refusing to evaluate.'
            );
          }
          const assessment = await driver.assess({
            latitude: plot.centroidLat,
            longitude: plot.centroidLong
          });
          observedValue = floodSeverityRank(assessment.severity);
          basis.flood = driver.name === 'http' ? 'live' : 'stub';
          basis.weather = 'unavailable'; // not consulted for flood products
        } else {
          const provider = this.resolveWeatherProvider();
          // Fail closed: stub weather observations are fabricated fixtures and
          // must never book real ledger payouts in production.
          if (isProduction() && provider.name !== 'http') {
            throw new ServiceUnavailableException(
              'Weather trigger evaluation requires the live weather provider in production ' +
                '(WEATHER_API_URL + WEATHER_API_KEY); the deterministic stub provider would ' +
                'book ledger payouts from fabricated data. Refusing to evaluate.'
            );
          }
          const series = await provider.observe({
            h3Cell,
            season: policy.season,
            windowDays: product.trigger.observationWindowDays
          });
          if (product.trigger.metric === 'rainfall_mm') {
            observedValue = aggregateRainfallMm(series.rainfallMm);
            dailyValues = series.rainfallMm;
          } else {
            observedValue = aggregateHeatDays(series.maxTempC);
            dailyValues = series.maxTempC;
          }
          basis.weather = series.basis;
          basis.flood = 'unavailable'; // not consulted for weather products
        }
      } catch (error) {
        if (isWeatherProviderError(error)) {
          report.unavailable += 1;
          return { policyId: policy.id, h3Cell, status: 'unavailable' };
        }
        throw error;
      }

      const evaluation = evaluateTrigger(product.trigger, observedValue);
      if (!evaluation.triggered) {
        return { policyId: policy.id, h3Cell, status: 'clear' };
      }
      report.triggered += 1;

      const band = payoutBandFor(product.payoutTable, evaluation.breachRatio);
      if (!band) {
        // Breach below every graduated band — no payout due by design.
        return { policyId: policy.id, h3Cell, status: 'clear' };
      }
      const payoutKobo = payoutKoboFor(policy.sumInsuredKobo, band.payoutPercent);
      const evidence: ParametricTriggerEvidence = {
        h3Cell,
        h3Resolution: product.trigger.h3Resolution,
        season: policy.season,
        windowDays: product.trigger.observationWindowDays,
        metric: product.trigger.metric,
        observedValue,
        ...(dailyValues ? { dailyValues } : {}),
        threshold: product.trigger.threshold,
        operator: product.trigger.operator,
        breachRatio: evaluation.breachRatio,
        basis,
        evaluatedAt: report.evaluatedAt
      };
      const fingerprint = computeEvidenceFingerprint([
        policy.id,
        policy.season,
        h3Cell,
        product.trigger.metric,
        observedValue,
        product.trigger.threshold,
        product.trigger.operator,
        basis.weather,
        basis.flood
      ]);
      const event: ParametricTriggerEvent = {
        id: newId('instrig'),
        policyId: policy.id,
        productId: product.id,
        farmerUserId: policy.farmerUserId,
        evidence,
        evidenceFingerprint: fingerprint,
        payoutPercent: band.payoutPercent,
        payoutKobo,
        createdAt: report.evaluatedAt
      };
      const persisted = await this.triggerEvents.upsert(event);
      if (!persisted.created) {
        // Idempotent replay. Self-heal a crash between event and payout:
        // if the payout never landed and the policy is still active, fall
        // through and propose it against the replayed event.
        const existingPayout = (
          await this.payouts.find({ triggerEventId: persisted.record.id })
        )[0];
        const current = await this.policies.findById(policy.id);
        if (existingPayout || !current || current.status !== 'active') {
          report.duplicates += 1;
          return { policyId: policy.id, h3Cell, status: 'duplicate' };
        }
        await this.proposePayout(actor, current, persisted.record, report);
        return { policyId: policy.id, h3Cell, status: 'triggered' };
      }
      await this.proposePayout(actor, policy, persisted.record, report);
      return { policyId: policy.id, h3Cell, status: 'triggered' };
    } catch (error) {
      // The production stub-provider guard above fails the whole run closed —
      // never downgrade it to a per-cell 'failed' outcome.
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      if (isWeatherProviderError(error)) {
        report.unavailable += 1;
        return { ...fallbackCell, status: 'unavailable' };
      }
      report.failed += 1;
      return fallbackCell;
    }
  }

  /**
   * Payout proposal through the double-entry ledger in STUB execution mode:
   * books insurer claims expense against claims payable (no cash moves —
   * real disbursement is externally gated). The policy walks
   * ACTIVE → TRIGGERED → PAYOUT_PROPOSED with domain events on each step.
   */
  private async proposePayout(
    actor: User,
    policy: ParametricPolicy,
    event: ParametricTriggerEvent,
    report: TriggerEvaluationReport
  ): Promise<void> {
    await this.ledger.ensureAccount({
      code: INSURER_CLAIMS_EXPENSE_ACCOUNT,
      type: 'expense'
    });
    await this.ledger.ensureAccount({
      code: INSURER_CLAIMS_PAYABLE_ACCOUNT,
      type: 'liability'
    });
    const payout: ParametricPayout = {
      id: newId('inspay'),
      policyId: policy.id,
      triggerEventId: event.id,
      farmerUserId: policy.farmerUserId,
      amountKobo: event.payoutKobo,
      status: 'proposed',
      origin: 'parametric',
      execution: 'stub',
      proposedAt: report.evaluatedAt
    };
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `insurance-payout-proposal:${event.id}`,
        referenceType: 'insurance_payout',
        referenceId: payout.id,
        description: `Parametric payout proposal for policy ${policy.id} (${policy.productCode}, stub execution)`,
        postings: [
          {
            accountCode: INSURER_CLAIMS_EXPENSE_ACCOUNT,
            direction: 'debit',
            amountKobo: payout.amountKobo
          },
          {
            accountCode: INSURER_CLAIMS_PAYABLE_ACCOUNT,
            direction: 'credit',
            amountKobo: payout.amountKobo
          }
        ]
      },
      actor.id
    );
    payout.ledgerProposalEntryId = entry.id;
    await this.payouts.upsert(payout);

    const now = report.evaluatedAt;
    await this.policies.transition(policy.id, 'active', {
      status: 'triggered',
      updatedAt: now
    });
    await this.events.publish(
      'insurance.trigger.raised',
      {
        policyId: policy.id,
        triggerEventId: event.id,
        payoutPercent: event.payoutPercent,
        payoutKobo: event.payoutKobo,
        basis: event.evidence.basis
      },
      actor.id
    );
    await this.policies.transition(policy.id, 'triggered', {
      status: 'payout_proposed',
      updatedAt: now
    });
    await this.events.publish(
      'insurance.payout.proposed',
      { policyId: policy.id, payoutId: payout.id, amountKobo: payout.amountKobo, execution: 'stub' },
      actor.id
    );
    report.payoutsProposed += 1;
  }

  /**
   * Confirms a proposed payout as PAID — STUB execution only. Books the
   * settlement entry (claims payable debit / farmer payout credit) through
   * the ledger; no real disbursement happens (external gates: insurer MOU +
   * payment rail activation).
   *
   * V-43: PAID means "settlement leg booked, awaiting rail confirmation" —
   * it NEVER means the farmer received money. Only confirmSettlement()
   * (rail confirmation reference) moves a payout to SETTLED, and a rail
   * failure reverses the leg and re-queues the payout to PROPOSED.
   *
   * FAIL-CLOSED (WP-G15, mirrors the Stage 23 escrow payout rail): stub
   * execution is the ONLY execution mode wired in this build, so in
   * production this endpoint refuses with 503 BEFORE anything is persisted
   * — a payout marked PAID against stub money movement would be a
   * fabricated financial record. Activation requires a real disbursement
   * rail (insurer MOU + payment provider), which is a separate package.
   */
  async confirmPayout(actor: User, payoutId: string): Promise<ParametricPayout> {
    requireAdmin(actor);
    if (isProduction()) {
      await this.audit?.record({
        actorId: actor.id,
        action: 'insurance.payout.unavailable',
        entityType: 'insurance_payout',
        entityId: payoutId,
        metadata: { execution: 'stub', production: true }
      });
      throw new ServiceUnavailableException(
        'Insurance payout execution is stub-only in this build — confirming would mark a payout ' +
          'PAID with no real disbursement. Production requires an insurer-approved live payout ' +
          'rail (not yet wired); refusing to confirm payout — nothing was posted or recorded.'
      );
    }
    const payout = await this.payouts.findById(payoutId);
    if (!payout) {
      throw new NotFoundException(`Insurance payout '${payoutId}' not found`);
    }
    if (payout.status !== 'proposed') {
      throw new ConflictException(`Only proposed payouts can be confirmed (payout is '${payout.status}')`);
    }
    const farmerAccount = `farmer:${payout.farmerUserId}:insurance_payouts`;
    await this.ledger.ensureAccount({
      code: farmerAccount,
      type: 'asset',
      ownerId: payout.farmerUserId
    });
    const entry = await this.ledger.postEntry(
      {
        // V-43: keyed per settlement ATTEMPT — a re-queued payout (settlement
        // failure reversed the previous leg) must post a fresh entry, never
        // replay the reversed one.
        idempotencyKey: `insurance-payout-settlement:${payout.id}:${payout.settlementAttempts ?? 0}`,
        referenceType: 'insurance_payout',
        referenceId: payout.id,
        description: `Parametric payout settlement for policy ${payout.policyId} (stub execution — no real disbursement)`,
        postings: [
          {
            accountCode: INSURER_CLAIMS_PAYABLE_ACCOUNT,
            direction: 'debit',
            amountKobo: payout.amountKobo
          },
          { accountCode: farmerAccount, direction: 'credit', amountKobo: payout.amountKobo }
        ]
      },
      actor.id
    );
    const now = new Date().toISOString();
    const paid: ParametricPayout = {
      ...payout,
      status: 'paid',
      ledgerSettlementEntryId: entry.id,
      paidAt: now
    };
    await this.payouts.update(paid);
    const policy = await this.policies.findById(payout.policyId);
    if (policy && policy.status === 'payout_proposed') {
      await this.policies.transition(policy.id, 'payout_proposed', {
        status: 'paid',
        updatedAt: now
      });
    }
    await this.events.publish(
      'insurance.payout.paid',
      { policyId: payout.policyId, payoutId: payout.id, amountKobo: payout.amountKobo, execution: 'stub' },
      actor.id
    );
    return paid;
  }

  /* --------------------- V-42: disputes, appeals, ex-gratia --------------------- */

  private async getPayout(payoutId: string): Promise<ParametricPayout> {
    const payout = await this.payouts.findById(payoutId);
    if (!payout) {
      throw new NotFoundException(`Insurance payout '${payoutId}' not found`);
    }
    return payout;
  }

  /** Appeal window guard (V-42): counted from the disputed/rejected-at timestamp. */
  private assertWithinAppealWindow(fromIso: string, action: string): void {
    const deadline = new Date(fromIso).getTime() + APPEAL_WINDOW_MS;
    if (Date.now() > deadline) {
      throw new BadRequestException(
        `The ${PAYOUT_APPEAL_WINDOW_DAYS}-day window to ${action} closed at ${new Date(deadline).toISOString()}`
      );
    }
  }

  /**
   * proposed → disputed (V-42). The policy holder flags a wrong/missed
   * trigger evaluation within the appeal window; the payout is frozen (it
   * can no longer be confirmed PAID) pending admin re-evaluation.
   */
  async disputePayout(actor: User, payoutId: string, reason: string): Promise<ParametricPayout> {
    const payout = await this.getPayout(payoutId);
    if (payout.farmerUserId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the policy holder can dispute a payout');
    }
    if (payout.status !== 'proposed') {
      throw new ConflictException(`Only proposed payouts can be disputed (payout is '${payout.status}')`);
    }
    if (!reason?.trim()) {
      throw new BadRequestException('A dispute reason is required (auditable record)');
    }
    this.assertWithinAppealWindow(payout.proposedAt, 'dispute this payout');
    const disputed: ParametricPayout = {
      ...payout,
      status: 'disputed',
      disputedAt: new Date().toISOString(),
      disputeReason: reason.trim()
    };
    await this.payouts.update(disputed);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.disputed',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: { policyId: payout.policyId, reason: disputed.disputeReason }
    });
    await this.events.publish(
      'insurance.payout.disputed',
      { policyId: payout.policyId, payoutId: payout.id, reason: disputed.disputeReason },
      actor.id
    );
    return disputed;
  }

  /**
   * proposed|disputed → rejected (V-42, admin). Rejection is a first-class
   * auditable terminal state for erroneous proposals — the row, the reason
   * and the audit entry are all retained, and the farmer may appeal within
   * the window.
   */
  async rejectPayout(actor: User, payoutId: string, reason: string): Promise<ParametricPayout> {
    requireAdmin(actor);
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'proposed' && payout.status !== 'disputed') {
      throw new ConflictException(
        `Only proposed or disputed payouts can be rejected (payout is '${payout.status}')`
      );
    }
    if (!reason?.trim()) {
      throw new BadRequestException('A rejection reason is required (auditable record)');
    }
    const rejected: ParametricPayout = {
      ...payout,
      status: 'rejected',
      rejectedAt: new Date().toISOString(),
      rejectionReason: reason.trim()
    };
    await this.payouts.update(rejected);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.rejected',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: {
        policyId: payout.policyId,
        fromStatus: payout.status,
        reason: rejected.rejectionReason,
        triggerEventId: payout.triggerEventId
      }
    });
    await this.events.publish(
      'insurance.payout.rejected',
      { policyId: payout.policyId, payoutId: payout.id, reason: rejected.rejectionReason },
      actor.id
    );
    return rejected;
  }

  /**
   * rejected → appealed (V-42). The policy holder appeals a rejection
   * within the appeal window; the payout becomes eligible for admin
   * re-evaluation with corrected evidence.
   */
  async appealPayout(actor: User, payoutId: string, reason: string): Promise<ParametricPayout> {
    const payout = await this.getPayout(payoutId);
    if (payout.farmerUserId !== actor.id && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only the policy holder can appeal a rejected payout');
    }
    if (payout.status !== 'rejected') {
      throw new ConflictException(`Only rejected payouts can be appealed (payout is '${payout.status}')`);
    }
    if (!reason?.trim()) {
      throw new BadRequestException('An appeal reason is required (auditable record)');
    }
    this.assertWithinAppealWindow(payout.rejectedAt ?? payout.proposedAt, 'appeal this payout');
    const appealed: ParametricPayout = {
      ...payout,
      status: 'appealed',
      appealedAt: new Date().toISOString(),
      appealReason: reason.trim()
    };
    await this.payouts.update(appealed);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.appealed',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: { policyId: payout.policyId, reason: appealed.appealReason }
    });
    await this.events.publish(
      'insurance.payout.appealed',
      { policyId: payout.policyId, payoutId: payout.id, reason: appealed.appealReason },
      actor.id
    );
    return appealed;
  }

  /**
   * Re-evaluates a disputed or appealed payout against CORRECTED evidence
   * (V-42). Deterministic: the corrected observed value is run through the
   * SAME product trigger + graduated payout table as the original
   * evaluation. Two outcomes:
   *   - corrected evidence still breaches → payout is re-proposed with the
   *     recomputed amount; when the amount changed, a balanced correcting
   *     leg (claims expense ↔ claims payable) is posted, idempotency-keyed
   *     to the corrected-evidence fingerprint so replays never double-post;
   *   - corrected evidence does not breach → the payout is rejected with
   *     the evaluation outcome recorded as the rejection reason.
   */
  async reevaluatePayout(
    actor: User,
    payoutId: string,
    corrected: CorrectedEvidenceInput
  ): Promise<ParametricPayout> {
    requireAdmin(actor);
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'disputed' && payout.status !== 'appealed') {
      throw new ConflictException(
        `Only disputed or appealed payouts can be re-evaluated (payout is '${payout.status}')`
      );
    }
    if (!Number.isFinite(corrected.observedValue)) {
      throw new BadRequestException('corrected.observedValue must be a finite number');
    }
    const policy = await this.getPolicy(payout.policyId);
    const product = await this.products.findById(policy.productId);
    if (!product) {
      throw new NotFoundException(`Insurance product '${policy.productId}' not found`);
    }
    const now = new Date().toISOString();
    const evaluation = evaluateTrigger(product.trigger, corrected.observedValue);
    const band = evaluation.triggered
      ? payoutBandFor(product.payoutTable, evaluation.breachRatio)
      : undefined;
    if (!evaluation.triggered || !band) {
      // Corrected evidence clears the breach → reject (auditable).
      const rejected: ParametricPayout = {
        ...payout,
        status: 'rejected',
        reevaluatedAt: now,
        rejectedAt: payout.status === 'appealed' ? payout.rejectedAt : now,
        rejectionReason:
          `Re-evaluation on corrected evidence (observed ${corrected.observedValue} ` +
          `${product.trigger.metric} vs ${product.trigger.operator} ${product.trigger.threshold}): ` +
          `trigger conditions not met.${corrected.notes ? ` ${corrected.notes}` : ''}`
      };
      await this.payouts.update(rejected);
      await this.audit?.record({
        actorId: actor.id,
        action: 'insurance.payout.reevaluated',
        entityType: 'insurance_payout',
        entityId: payout.id,
        metadata: {
          policyId: payout.policyId,
          outcome: 'rejected',
          correctedObservedValue: corrected.observedValue,
          notes: corrected.notes
        }
      });
      await this.events.publish(
        'insurance.payout.rejected',
        { policyId: payout.policyId, payoutId: payout.id, reason: rejected.rejectionReason },
        actor.id
      );
      return rejected;
    }
    const newAmountKobo = payoutKoboFor(policy.sumInsuredKobo, band.payoutPercent);
    if (newAmountKobo !== payout.amountKobo) {
      // Correcting leg keeps the books balanced and traceable: top-up when
      // the recomputed band is higher, claw back the excess when lower.
      const diff = newAmountKobo - payout.amountKobo;
      const fingerprint = computeEvidenceFingerprint([
        payout.id,
        policy.id,
        product.trigger.metric,
        corrected.observedValue,
        newAmountKobo
      ]);
      await this.ledger.ensureAccount({
        code: INSURER_CLAIMS_EXPENSE_ACCOUNT,
        type: 'expense'
      });
      await this.ledger.ensureAccount({
        code: INSURER_CLAIMS_PAYABLE_ACCOUNT,
        type: 'liability'
      });
      await this.ledger.postEntry(
        {
          idempotencyKey: `insurance-payout-reevaluation:${fingerprint}`,
          referenceType: 'insurance_payout_reevaluation',
          referenceId: payout.id,
          description:
            `Payout re-evaluation correction for policy ${policy.id}: ` +
            `${payout.amountKobo} → ${newAmountKobo} kobo (corrected evidence)`,
          postings:
            diff > 0
              ? [
                  { accountCode: INSURER_CLAIMS_EXPENSE_ACCOUNT, direction: 'debit', amountKobo: diff },
                  { accountCode: INSURER_CLAIMS_PAYABLE_ACCOUNT, direction: 'credit', amountKobo: diff }
                ]
              : [
                  { accountCode: INSURER_CLAIMS_PAYABLE_ACCOUNT, direction: 'debit', amountKobo: -diff },
                  { accountCode: INSURER_CLAIMS_EXPENSE_ACCOUNT, direction: 'credit', amountKobo: -diff }
                ]
        },
        actor.id
      );
    }
    const reproposed: ParametricPayout = {
      ...payout,
      status: 'proposed',
      amountKobo: newAmountKobo,
      reevaluatedAt: now
    };
    await this.payouts.update(reproposed);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.reevaluated',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: {
        policyId: payout.policyId,
        outcome: 'reproposed',
        previousAmountKobo: payout.amountKobo,
        amountKobo: newAmountKobo,
        payoutPercent: band.payoutPercent,
        correctedObservedValue: corrected.observedValue,
        notes: corrected.notes
      }
    });
    await this.events.publish(
      'insurance.payout.reproposed',
      {
        policyId: payout.policyId,
        payoutId: payout.id,
        previousAmountKobo: payout.amountKobo,
        amountKobo: newAmountKobo,
        payoutPercent: band.payoutPercent
      },
      actor.id
    );
    return reproposed;
  }

  /**
   * Ex-gratia payout proposal (V-42 basis-risk safety valve): a crop loss
   * the parametric trigger missed can still be compensated through a
   * documented, admin-approved ex-gratia instrument. The payout carries no
   * trigger event (origin 'ex_gratia'), is bounded by the sum insured, and
   * walks the SAME proposed → paid → settled rail as parametric payouts —
   * it never bypasses the settlement confirmation gate (V-43).
   */
  async proposeExGratiaPayout(actor: User, input: ExGratiaPayoutInput): Promise<ParametricPayout> {
    requireAdmin(actor);
    if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo <= 0) {
      throw new BadRequestException('amountKobo must be a positive integer kobo amount');
    }
    if (!input.reason?.trim()) {
      throw new BadRequestException('An ex-gratia reason is required (auditable basis-risk record)');
    }
    const policy = await this.getPolicy(input.policyId);
    if (input.amountKobo > policy.sumInsuredKobo) {
      throw new BadRequestException(
        `Ex-gratia amount exceeds the sum insured (${policy.sumInsuredKobo} kobo)`
      );
    }
    await this.ledger.ensureAccount({
      code: INSURER_CLAIMS_EXPENSE_ACCOUNT,
      type: 'expense'
    });
    await this.ledger.ensureAccount({
      code: INSURER_CLAIMS_PAYABLE_ACCOUNT,
      type: 'liability'
    });
    const payout: ParametricPayout = {
      id: newId('inspay'),
      policyId: policy.id,
      farmerUserId: policy.farmerUserId,
      amountKobo: input.amountKobo,
      status: 'proposed',
      origin: 'ex_gratia',
      execution: 'stub',
      proposedAt: new Date().toISOString()
    };
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `insurance-payout-ex-gratia:${payout.id}`,
        referenceType: 'insurance_payout',
        referenceId: payout.id,
        description:
          `Ex-gratia payout proposal for policy ${policy.id} (${policy.productCode}): ` +
          `${input.reason.trim()} (stub execution)`,
        postings: [
          {
            accountCode: INSURER_CLAIMS_EXPENSE_ACCOUNT,
            direction: 'debit',
            amountKobo: payout.amountKobo
          },
          {
            accountCode: INSURER_CLAIMS_PAYABLE_ACCOUNT,
            direction: 'credit',
            amountKobo: payout.amountKobo
          }
        ]
      },
      actor.id
    );
    payout.ledgerProposalEntryId = entry.id;
    await this.payouts.upsert(payout);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.ex_gratia_proposed',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: {
        policyId: policy.id,
        amountKobo: payout.amountKobo,
        reason: input.reason.trim()
      }
    });
    await this.events.publish(
      'insurance.payout.proposed',
      {
        policyId: policy.id,
        payoutId: payout.id,
        amountKobo: payout.amountKobo,
        origin: 'ex_gratia',
        execution: 'stub'
      },
      actor.id
    );
    return payout;
  }

  /* --------------- V-43: settlement confirmation + failure reversal --------------- */

  /**
   * paid → settled (V-43). Settlement is triggered ONLY by a confirmation
   * reference from the insurer's payout rail — never by the ledger posting
   * (confirmPayout books the leg; this endpoint records that real money
   * actually reached the farmer).
   *
   * FAIL-CLOSED: the only execution mode wired in this build is the stub
   * rail, which cannot produce a real confirmation — in production this
   * refuses with 503 before persisting anything (E-02 gate, same doctrine
   * as confirmPayout).
   */
  async confirmSettlement(
    actor: User,
    payoutId: string,
    railReference: string
  ): Promise<ParametricPayout> {
    requireAdmin(actor);
    if (isProduction()) {
      await this.audit?.record({
        actorId: actor.id,
        action: 'insurance.payout.unavailable',
        entityType: 'insurance_payout',
        entityId: payoutId,
        metadata: { operation: 'confirmSettlement', execution: 'stub', production: true }
      });
      throw new ServiceUnavailableException(
        'Insurance payout settlement requires a confirmation from an insurer-approved live payout ' +
          'rail (not yet wired); the stub rail cannot produce one. Refusing to settle — nothing was recorded.'
      );
    }
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'paid') {
      throw new ConflictException(
        `Only paid payouts can be settled (payout is '${payout.status}')`
      );
    }
    if (!railReference?.trim()) {
      throw new BadRequestException('A rail confirmation reference is required to settle a payout');
    }
    const settled: ParametricPayout = {
      ...payout,
      status: 'settled',
      settledAt: new Date().toISOString(),
      settlementReference: railReference.trim()
    };
    await this.payouts.update(settled);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.settled',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: { policyId: payout.policyId, railReference: settled.settlementReference }
    });
    await this.events.publish(
      'insurance.payout.settled',
      {
        policyId: payout.policyId,
        payoutId: payout.id,
        amountKobo: payout.amountKobo,
        railReference: settled.settlementReference
      },
      actor.id
    );
    return settled;
  }

  /**
   * paid → proposed (V-43 failed-settlement reversal). When the rail reports
   * the disbursement failed, the settlement leg is reversed (balanced
   * counter-entry via LedgerService.reverseEntry — idempotent, the original
   * entry stays untouched) and the payout is RE-QUEUED to 'proposed' for a
   * fresh confirmation attempt. The proposal leg (claims expense/payable)
   * intentionally stays booked: the obligation to the farmer still stands.
   */
  async recordSettlementFailure(
    actor: User,
    payoutId: string,
    reason: string
  ): Promise<ParametricPayout> {
    requireAdmin(actor);
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'paid') {
      throw new ConflictException(
        `Only paid payouts can record a settlement failure (payout is '${payout.status}')`
      );
    }
    if (!reason?.trim()) {
      throw new BadRequestException('A settlement failure reason is required (auditable record)');
    }
    if (!payout.ledgerSettlementEntryId) {
      throw new ConflictException(
        `Payout '${payoutId}' has no settlement ledger entry to reverse`
      );
    }
    const reversal = await this.ledger.reverseEntry(payout.ledgerSettlementEntryId, actor.id);
    const requeued: ParametricPayout = {
      ...payout,
      status: 'proposed',
      ledgerSettlementEntryId: undefined,
      paidAt: undefined,
      settlementFailureReason: reason.trim(),
      // Next confirmation posts a fresh settlement leg (new idempotency key).
      settlementAttempts: (payout.settlementAttempts ?? 0) + 1
    };
    await this.payouts.update(requeued);
    await this.audit?.record({
      actorId: actor.id,
      action: 'insurance.payout.settlement_failed',
      entityType: 'insurance_payout',
      entityId: payout.id,
      metadata: {
        policyId: payout.policyId,
        reason: requeued.settlementFailureReason,
        reversedEntryId: payout.ledgerSettlementEntryId,
        reversalEntryId: reversal.id
      }
    });
    await this.events.publish(
      'insurance.payout.settlement_failed',
      {
        policyId: payout.policyId,
        payoutId: payout.id,
        amountKobo: payout.amountKobo,
        reason: requeued.settlementFailureReason,
        reversalEntryId: reversal.id
      },
      actor.id
    );
    return requeued;
  }

  /** Aggregated portfolio view for the insurer read API (insurance:read scope). */
  async insurerPortfolio(): Promise<InsurerPortfolio> {
    const [policies, payouts, events] = await Promise.all([
      this.policies.all(),
      this.payouts.all(),
      this.triggerEvents.all()
    ]);
    const policiesByStatus: Record<string, number> = {};
    let totalSumInsuredKobo = 0;
    let totalPremiumKobo = 0;
    for (const policy of policies) {
      policiesByStatus[policy.status] = (policiesByStatus[policy.status] ?? 0) + 1;
      totalSumInsuredKobo += policy.sumInsuredKobo;
      totalPremiumKobo += policy.premiumKobo;
    }
    const payoutsByStatus: Record<string, number> = {};
    let totalPayoutKobo = 0;
    let unsettledPayoutKobo = 0;
    for (const payout of payouts) {
      payoutsByStatus[payout.status] = (payoutsByStatus[payout.status] ?? 0) + 1;
      totalPayoutKobo += payout.amountKobo;
      if (payout.status === 'paid') {
        // V-43: ledger-booked but not rail-confirmed — live farmer-facing obligation.
        unsettledPayoutKobo += payout.amountKobo;
      }
    }
    // V-43 solvency tracking: the claims-payable ledger balance is the
    // booked-but-unsettled claim obligation (credit-normal account).
    let claimsPayableBalanceKobo = 0;
    try {
      const payable = await this.ledger.balance(INSURER_CLAIMS_PAYABLE_ACCOUNT);
      claimsPayableBalanceKobo = -payable.balanceKobo; // debit-positive convention → credit balance
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error; // account absent = no proposals yet; a store failure must surface
      }
    }
    return {
      policiesByStatus,
      totalSumInsuredKobo,
      totalPremiumKobo,
      payoutsByStatus,
      totalPayoutKobo,
      triggerEventCount: events.length,
      unsettledPayoutKobo,
      claimsPayableBalanceKobo
    };
  }

  insurerTriggerEvents(): Promise<ParametricTriggerEvent[]> {
    return this.triggerEvents.all();
  }
}
