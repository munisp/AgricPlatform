/**
 * Credit suite types (Wave CREDIT — best-of-both merge of the
 * farmer-data-collection microfinance suite into AgricPlatform).
 *
 * Money is integer kobo throughout — never floats. PostgreSQL columns are
 * bigint; the API carries safe integers (validated with Number.isSafeInteger
 * at the trust boundary) and all interest/proration math is computed with
 * bigint internally before being narrowed.
 */

/* ----------------------------------------------------------- statuses -- */

export const CREDIT_LOAN_STATUSES = [
  'draft',
  'submitted',
  'scoring',
  'approved',
  'rejected',
  'disbursed',
  'repaying',
  'repaid',
  'defaulted',
  'written_off',
  /**
   * Terminal: the loan's open schedule was folded into a top-up
   * consolidation loan (V-30). No further payments are recorded against a
   * consolidated loan; its repayment history still counts in scoring.
   */
  'consolidated'
] as const;
export type CreditLoanStatus = (typeof CREDIT_LOAN_STATUSES)[number];

export const CREDIT_REPAYMENT_STATUSES = [
  'pending',
  'paid',
  'late',
  'missed',
  /**
   * The installment belonged to a schedule that a restructure (V-04) or a
   * top-up consolidation (V-30) replaced. Superseded rows are immutable
   * audit history — they never accept payments and never count as open.
   */
  'superseded'
] as const;
export type CreditRepaymentStatus = (typeof CREDIT_REPAYMENT_STATUSES)[number];

export const CREDIT_COLLATERAL_STATUSES = ['pledged', 'released', 'claimed'] as const;
export type CreditCollateralStatus = (typeof CREDIT_COLLATERAL_STATUSES)[number];

export const CREDIT_GUARANTOR_STATUSES = [
  'invited',
  'accepted',
  'declined',
  /**
   * Guarantor demand lifecycle (V-28): when a guaranteed loan defaults,
   * every accepted guarantor is CALLED with a computed demand share.
   * called → liable (guarantor accepted the liability; a balanced
   * receivable leg is posted) → settled (demand paid, optionally by a
   * consent-gated savings debit).
   */
  'called',
  'liable',
  'settled'
] as const;
export type CreditGuarantorStatus = (typeof CREDIT_GUARANTOR_STATUSES)[number];

export const CREDIT_GROUP_STATUSES = ['active', 'dissolved'] as const;
export type CreditGroupStatus = (typeof CREDIT_GROUP_STATUSES)[number];

export const CREDIT_GROUP_ROLES = ['member', 'leader'] as const;
export type CreditGroupRole = (typeof CREDIT_GROUP_ROLES)[number];

export const SAVINGS_DIRECTIONS = ['deposit', 'withdrawal'] as const;
export type SavingsDirection = (typeof SAVINGS_DIRECTIONS)[number];

/* ----------------------------------------------------------- products -- */

export interface CreditLoanProduct {
  id: string;
  name: string;
  minPrincipalKobo: number;
  maxPrincipalKobo: number;
  /** Annual interest in basis points (1% = 100 bps), prorated over termDays. */
  interestBpsAnnual: number;
  termDays: number;
  /** VSLA/chama group lending product (co-obligor applications). */
  groupLending: boolean;
  active: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------ scoring -- */

/**
 * Deterministic 5-factor credit model ported from the source suite's
 * credit-scoring service (payment history / utilization / history length /
 * diversity / inquiries) and re-anchored to AgricPlatform data:
 *   - repaymentHistory:     prior loan performance (own credit repo)
 *   - profileCompleteness:  farm profile completion (profiles.completionScore)
 *   - transactionVolume:    marketplace order history (orders repo)
 *   - guarantorStrength:    accepted guarantors backing the applicant
 *   - groupStanding:        VSLA/chama membership + leadership + group savings
 * Each factor contributes 0–200; the total score is 0–1000.
 */
export interface CreditScoreFactors {
  repaymentHistory: number;
  profileCompleteness: number;
  transactionVolume: number;
  guarantorStrength: number;
  groupStanding: number;
}

export const CREDIT_SCORE_MAX = 1000;
export const CREDIT_FACTOR_MAX = 200;

export interface CreditScoreAssessment {
  userId: string;
  /** 0–1000, sum of the five factors. */
  score: number;
  factors: CreditScoreFactors;
  computedAt: string;
}

/* ------------------------------------------------------------- loans --- */

export interface CreditLoanApplication {
  id: string;
  applicantUserId: string;
  productId: string;
  principalKobo: number;
  status: CreditLoanStatus;
  creditScore?: number;
  scoreFactors?: CreditScoreFactors;
  purpose?: string;
  /** Set for VSLA/chama group loan applications. */
  groupId?: string;
  /**
   * Optional link to the financed plot / planting (V-03). Persisted at
   * application time so a farms planting-failure event can find the loan
   * and trigger the grace path (aging suspension + review flag).
   */
  plotId?: string;
  plantingId?: string;
  /**
   * Review flag set by automated triggers. Currently only 'crop_failure'
   * (V-03): set together with agingSuspendedAt; cleared when a reviewer
   * resolves the review (e.g. by restructuring the loan, V-04).
   */
  reviewFlag?: string;
  /** When set, pending installments do not age into 'late' at read time. */
  agingSuspendedAt?: string;
  /** V-30 top-up: this application consolidates the named repaying loan. */
  consolidatesLoanId?: string;
  /** V-05 settlement-for-less: cash actually received at settlement. */
  settledAmountKobo?: number;
  /** V-05 settlement-for-less: outstanding balance written down. */
  writeDownKobo?: number;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface CreditRepayment {
  id: string;
  loanId: string;
  /** 1-based position in the amortisation schedule. */
  sequence: number;
  dueAt: string;
  amountKobo: number;
  paidAt?: string;
  /**
   * Cumulative amount paid against this installment (V-29 partial
   * payments). Rows created after migration 094 always carry a value
   * (0 when unpaid); pre-094 rows may read undefined — treat as 0.
   * The installment is fully covered when paidAmountKobo >= amountKobo.
   */
  paidAmountKobo?: number;
  /**
   * 1-based schedule generation (V-04 restructure): the original schedule
   * is version 1; each restructure/consolidation appends rows with the
   * next version and supersedes the open rows of the previous one.
   */
  scheduleVersion?: number;
  /**
   * Stored status. 'late' is computed at read time (due_at < now && still
   * pending) — no timers mutate this row; 'missed' is set explicitly by a
   * reviewer when the loan is defaulted; 'superseded' marks rows replaced
   * by a restructure/consolidation (immutable audit history).
   */
  status: CreditRepaymentStatus;
}

export interface CreditCollateral {
  id: string;
  loanId: string;
  kind: string;
  description: string;
  estimatedValueKobo: number;
  status: CreditCollateralStatus;
  /**
   * V-31: when the collateral is a warehouse-pledged receipt, the pledge /
   * receipt references are recorded here so a claim can drive the
   * warehouse liquidation path (the `credit.collateral.claimed` event
   * carries them; the warehouse subscriber lives outside this module).
   */
  warehousePledgeId?: string;
  warehouseReceiptId?: string;
}

/**
 * V-04: immutable audit record of a loan restructure. One row per
 * restructure; `version` increments per loan. `supersededSchedule` is the
 * pinned snapshot of the replaced open installments (sequence, dueAt,
 * amountKobo, paidAmountKobo) so the old terms survive replacement.
 */
export interface CreditLoanRestructure {
  id: string;
  loanId: string;
  /** 1-based per-loan restructure version (append-only). */
  version: number;
  reason: string;
  /** Outstanding balance (unpaid installment remainder) carried forward. */
  outstandingKobo: number;
  /** Snapshot of the superseded open installments. */
  supersededSchedule: {
    repaymentId: string;
    sequence: number;
    dueAt: string;
    amountKobo: number;
    paidAmountKobo: number;
  }[];
  /** Installment count of the replacement schedule. */
  newInstallmentCount: number;
  /** Credit score recomputed at restructure time (factor hook, V-04). */
  scoreAfter?: number;
  createdBy: string;
  createdAt: string;
}

/* ----------------------------------------- seasonal schedules (SeasonSync) -- */

export const CREDIT_SEASONAL_SCHEDULE_STATUSES = [
  'previewed',
  'accepted',
  'superseded'
] as const;
export type CreditSeasonalScheduleStatus = (typeof CREDIT_SEASONAL_SCHEDULE_STATUSES)[number];

/**
 * One seasonal installment: due date + integer kobo amount. The sum of a
 * schedule's installments always equals principal + prorated interest —
 * identical to the equal-installment invariant (largest-remainder rounding).
 */
export interface CreditSeasonalInstallment {
  /** 1-based position in the schedule. */
  sequence: number;
  dueAt: string;
  amountKobo: number;
}

/**
 * SeasonSync pinned seasonal schedule (migration 055): an immutable
 * snapshot of the crop-calendar inputs and the computed installments.
 * Accepting a schedule replaces the loan's pending credit.loan_repayments
 * rows with these installments; the repayment posting path is unchanged.
 */
export interface CreditSeasonalSchedule {
  id: string;
  loanId: string;
  /** Plot whose planting produced the calendar; undefined when the calendar
   * was captured explicitly at preview time. */
  plotId?: string;
  crop: string;
  /** ISO date (YYYY-MM-DD). */
  plantingDate: string;
  harvestWindowStart: string;
  harvestWindowEnd: string;
  installments: CreditSeasonalInstallment[];
  /** 1-based per-loan version; re-previews append, never mutate. */
  version: number;
  status: CreditSeasonalScheduleStatus;
  createdBy: string;
  createdAt: string;
  acceptedAt?: string;
}

export interface CreditGuarantor {
  id: string;
  loanId: string;
  guarantorUserId: string;
  status: CreditGuarantorStatus;
  /**
   * V-28 demand lifecycle: the guarantor's computed share of the defaulted
   * loan's outstanding balance, set when the demand is issued (called).
   */
  demandAmountKobo?: number;
  demandedAt?: string;
  /** Set when the guarantor accepts the liability (called → liable). */
  liabilityAcceptedAt?: string;
  /** Set when the demand is settled (liable → settled). */
  settledAt?: string;
  /**
   * Recorded consent reference when the settlement debited the guarantor's
   * savings account (V-28: savings debit ONLY with recorded consent).
   */
  consentRef?: string;
}

/* ------------------------------------------------- groups (chama/VSLA) -- */

export interface CreditGroup {
  id: string;
  name: string;
  chapterId?: string;
  createdBy: string;
  createdAt: string;
  /**
   * V-46: 'active' groups accept membership changes and loan applications;
   * 'dissolved' is terminal. Dissolution is blocked while the group has
   * open liabilities (live group loans or unsettled guarantor demands).
   */
  status: CreditGroupStatus;
  dissolvedAt?: string;
}

export interface CreditGroupMember {
  groupId: string;
  userId: string;
  role: CreditGroupRole;
  joinedAt: string;
}

/* ------------------------------------------------------------ savings -- */

export interface CreditSavingsAccount {
  id: string;
  /** Personal account owner (mutually exclusive with groupId). */
  userId?: string;
  /** VSLA group account (mutually exclusive with userId). */
  groupId?: string;
  balanceKobo: number;
  updatedAt: string;
}

export interface CreditSavingsTransaction {
  id: string;
  accountId: string;
  direction: SavingsDirection;
  amountKobo: number;
  balanceAfterKobo: number;
  /** Idempotency key — unique per transaction. */
  ref: string;
  createdAt: string;
}

/* ---------------------------------------------------------- portfolio -- */

/**
 * Portfolio-at-risk report. PAR-N = outstanding kobo on loans with any
 * repayment overdue ≥ N days ÷ total outstanding kobo. Ratios are returned
 * as integer basis points (0–10000) to keep the API float-free.
 */
export interface CreditPortfolioReport {
  generatedAt: string;
  totalLoans: number;
  activeLoans: number;
  defaultedLoans: number;
  /** Sum of unpaid repayment amounts across active loans. */
  outstandingKobo: number;
  /** Sum of unpaid repayment amounts across defaulted loans. */
  defaultedKobo: number;
  par30Kobo: number;
  par60Kobo: number;
  par90Kobo: number;
  par30Bps: number;
  par60Bps: number;
  par90Bps: number;
}

/* ------------------------- geo-verified credit (wave-geocredit, shadow) -- */

/** Provenance of a geo factor input: stub fixture vs live sidecar inference. */
export type GeoCreditInputBasis = 'stub' | 'live';

/** Crop input can additionally be honestly 'unavailable' (fail-closed). */
export type GeoCreditCropBasis = 'stub' | 'live' | 'unavailable';

export type GeoCreditFactorStatus = 'computed' | 'unavailable';

/** Component breakdown of the geo-verified credit factor (max 100 total). */
export interface GeoCreditFactorBreakdown {
  /** 0 or 25 — plot exists, has coordinates and belongs to the applicant. */
  plotVerification: number;
  /** 0 or 15 — stored plot area inside the plausible band (0.01–100 ha). */
  areaPlausibility: number;
  /** 0–20 — flood-risk band points (none=20 … severe=0). */
  floodRisk: number;
  /** 0–30 — crop health_score scaled from 0–100. */
  cropHealth: number;
  /** 0–10 — freshness of the underlying plot record. */
  dataFreshness: number;
}

export interface GeoCreditBasisFlags {
  flood: GeoCreditInputBasis;
  crop: GeoCreditCropBasis;
}

/**
 * A shadow-mode geo-verified credit score. Persisted ONLY to
 * credit.geo_credit_shadow_scores (migration 028) and never read by the
 * live approve/decline decision path. factorScore is null when status is
 * 'unavailable' (live crop-ml configured but unreachable — fail-closed).
 */
export interface GeoCreditShadowScore {
  applicationId: string;
  factorScore: number | null;
  status: GeoCreditFactorStatus;
  breakdown: GeoCreditFactorBreakdown;
  basis: GeoCreditBasisFlags;
  inputFingerprint: string;
  computedAt: string;
}

/* ------------- cooperative score (stage-27 Innovation 14, flag coop-score)

 * Institution-level credit readiness for the cooperative itself (the actual
 * counterparty for group loans and offtake), scored deterministically 0-1000
 * from five weighted factors. Persisted versioned + append-only to
 * credit.coop_scores (migration 072); the same number and the same
 * explainability payload are returned to every authorised role.
 */

export const COOP_SCORE_BANDS = ['A', 'B', 'C', 'D'] as const;
export type CoopScoreBand = (typeof COOP_SCORE_BANDS)[number];

export const COOP_SCORE_FACTOR_KEYS = [
  'repaymentTrackRecord',
  'vslaCycleDiscipline',
  'governanceActivity',
  'commercialReliability',
  'dataCompleteness'
] as const;
export type CoopScoreFactorKey = (typeof COOP_SCORE_FACTOR_KEYS)[number];

/**
 * Per-factor provenance badge:
 *  - 'measured':    enough real observations to score the factor fully;
 *  - 'sparse':      some evidence but below the minimum sample — the
 *                   factor's contribution is BOUNDED (half weight cap), never
 *                   interpolated or fabricated;
 *  - 'unavailable': the source module was unreadable (or no data at all) —
 *                   the factor contributes 0 with this badge, fail-closed.
 */
export const COOP_FACTOR_BASES = ['measured', 'sparse', 'unavailable'] as const;
export type CoopFactorBasis = (typeof COOP_FACTOR_BASES)[number];

/** One factor's contribution to the composite score (explainability row). */
export interface CoopScoreFactorBreakdown {
  key: CoopScoreFactorKey;
  /** Maximum points this factor can contribute (weights sum to 1000). */
  weight: number;
  /** Points actually awarded (0..weight; bounded at weight/2 when sparse). */
  points: number;
  basis: CoopFactorBasis;
  /** Named numeric inputs the factor was computed from (auditable basis). */
  summary: Record<string, number>;
}

/**
 * A versioned cooperative score row (credit.coop_scores). `version` increases
 * monotonically per cooperative; `inputsHash` makes recompute idempotent.
 */
export interface CoopScore {
  cooperativeId: string;
  version: number;
  /** 0-1000, the exact sum of factor points. */
  score: number;
  band: CoopScoreBand;
  factors: CoopScoreFactorBreakdown[];
  inputsHash: string;
  computedAt: string;
}
