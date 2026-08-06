/**
 * Parametric insurance rail (wave-insurance, migration 031, schema
 * `insurance`). Domain primitives for parametric products, policies,
 * trigger events and payout proposals. Money is integer kobo everywhere;
 * trigger evaluation is deterministic and every evidence payload carries
 * honest basis flags ('stub' | 'live' | 'unavailable') — simulated weather
 * fixtures are never presented as live observations. Payout execution is
 * STUB only: proposals settle through the double-entry ledger, and real
 * disbursement is gated externally (insurer MOU + payment rail activation).
 */

export const PARAMETRIC_PERILS = ['RAINFALL_DEFICIT', 'FLOOD', 'HEAT_STRESS'] as const;
export type ParametricPeril = (typeof PARAMETRIC_PERILS)[number];

export const PARAMETRIC_POLICY_STATUSES = [
  'quoted',
  'active',
  'triggered',
  'payout_proposed',
  'paid',
  'expired'
] as const;
export type ParametricPolicyStatus = (typeof PARAMETRIC_POLICY_STATUSES)[number];

/** Flood severity rank ladder, shared with the geo-intel flood driver. */
export const FLOOD_SEVERITY_RANKS = ['none', 'low', 'moderate', 'high', 'severe'] as const;
export type FloodSeverityRank = (typeof FLOOD_SEVERITY_RANKS)[number];

/**
 * Parametric trigger definition. `metric` selects the observation source:
 * rainfall_mm and heat_days come from the WeatherProvider port, flood_rank
 * from the geo-intel flood-risk port. `operator` + `threshold` define the
 * breach: 'lte' fires when observed <= threshold (rainfall deficit),
 * 'gte' fires when observed >= threshold (flood rank, heat days).
 */
export interface ParametricTriggerDefinition {
  metric: 'rainfall_mm' | 'flood_rank' | 'heat_days';
  operator: 'lte' | 'gte';
  threshold: number;
  /** H3 resolution of the observation cell (one of the indexed 5/7/9). */
  h3Resolution: 5 | 7 | 9;
  /** Observation window length in days within the season. */
  observationWindowDays: number;
  /** Season label the product covers (e.g. '2026-wet'). */
  season: string;
}

/**
 * Graduated payout table: breach-severity ratio bands mapped to a percent
 * of the sum insured. The breach ratio is 0 exactly at the threshold and
 * grows with breach severity (see docs/parametric-insurance.md). Bands are
 * evaluated from the highest minRatio down; the first matching band wins.
 * The minRatio:0 band makes exactly-at-threshold breaches pay the lowest
 * band — an at-threshold breach is still a breach.
 */
export interface ParametricPayoutBand {
  minRatio: number;
  payoutPercent: number;
}

export interface ParametricProduct {
  id: string;
  /** Stable business code (unique), e.g. 'NG-RAIN-WET-26'. */
  code: string;
  name: string;
  description: string;
  peril: ParametricPeril;
  trigger: ParametricTriggerDefinition;
  payoutTable: ParametricPayoutBand[];
  /** Base premium rate in basis points of the sum insured. */
  premiumRateBps: number;
  createdAt: string;
}

export interface ParametricPolicy {
  id: string;
  farmerUserId: string;
  plotId: string;
  productId: string;
  productCode: string;
  season: string;
  sumInsuredKobo: number;
  premiumKobo: number;
  /** Flood band captured at quote time (premium modifier + evidence). */
  floodBand: FloodSeverityRank;
  /** Basis of the flood input used for pricing ('stub' default). */
  pricingBasis: 'stub' | 'live';
  status: ParametricPolicyStatus;
  createdAt: string;
  updatedAt: string;
}

/** Evidence provenance flags on a trigger evaluation. */
export interface ParametricBasisFlags {
  weather: 'stub' | 'live' | 'unavailable';
  flood: 'stub' | 'live' | 'unavailable';
}

/**
 * Trigger evidence: everything needed to reproduce the evaluation without
 * trusting the evaluator. `observedValue` is the aggregate compared to the
 * threshold (total mm over the window, heat-day count, or flood rank).
 */
export interface ParametricTriggerEvidence {
  h3Cell: string;
  h3Resolution: number;
  season: string;
  windowDays: number;
  metric: ParametricTriggerDefinition['metric'];
  observedValue: number;
  /** Daily observed series behind the aggregate (weather metrics only). */
  dailyValues?: number[];
  threshold: number;
  operator: ParametricTriggerDefinition['operator'];
  /** 0 exactly at threshold; grows with breach severity. */
  breachRatio: number;
  basis: ParametricBasisFlags;
  evaluatedAt: string;
}

export interface ParametricTriggerEvent {
  id: string;
  policyId: string;
  productId: string;
  farmerUserId: string;
  evidence: ParametricTriggerEvidence;
  /** Deterministic fingerprint of (policy, evidence inputs) for idempotency. */
  evidenceFingerprint: string;
  payoutPercent: number;
  payoutKobo: number;
  createdAt: string;
}

export const PARAMETRIC_PAYOUT_STATUSES = ['proposed', 'paid'] as const;
export type ParametricPayoutStatus = (typeof PARAMETRIC_PAYOUT_STATUSES)[number];

export interface ParametricPayout {
  id: string;
  policyId: string;
  triggerEventId: string;
  farmerUserId: string;
  amountKobo: number;
  status: ParametricPayoutStatus;
  /** Honest execution label — always 'stub' in this wave. */
  execution: 'stub';
  ledgerProposalEntryId?: string;
  ledgerSettlementEntryId?: string;
  proposedAt: string;
  paidAt?: string;
}

/** Quote response: deterministic premium breakdown (rate card mirror). */
export interface ParametricQuote {
  productCode: string;
  season: string;
  sumInsuredKobo: number;
  premiumRateBps: number;
  floodBand: FloodSeverityRank;
  floodModifierBps: number;
  premiumKobo: number;
  pricingBasis: 'stub' | 'live';
}
