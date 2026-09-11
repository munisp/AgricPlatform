/**
 * Cooperative Score (stage-27 Innovation 14) — the deterministic
 * institution-level credit readiness score (0-1000) for the cooperative
 * itself. This module is PURE: no I/O, no clocks, no randomness. All inputs
 * are pre-aggregated counts assembled by CoopScoreService, so the same
 * inputs always produce the same outputs (unit-testable known-answer
 * vectors). No ML — deterministic weighted factors only.
 *
 * Sparse-data doctrine: a factor whose evidence base is below its minimum
 * sample is capped at half its weight and badged 'sparse'; a factor whose
 * source module is unreadable (input = null) contributes 0 and is badged
 * 'unavailable'. Missing data LOWERS the score honestly — nothing is ever
 * interpolated or fabricated.
 */
import type {
  CoopFactorBasis,
  CoopScoreBand,
  CoopScoreFactorBreakdown,
  CoopScoreFactorKey
} from '@agric-platform/shared';

/* ------------------------------------------------------------- weights --

 * Weighting table (max 1000). Rationale:
 *
 *   repaymentTrackRecord   300  Direct loan-performance evidence (PAR-style
 *                               on-time/late/missed kobo across member and
 *                               group loans). The strongest default signal,
 *                               so the largest weight.
 *   vslaCycleDiscipline    200  VSLA cycle completion + share-out payout
 *                               follow-through. Internal governance of pooled
 *                               money is the closest analogue to servicing a
 *                               group facility.
 *   governanceActivity     150  Chapter meeting cadence + attendance. A real
 *                               but indirect signal (engagement, not money),
 *                               so weighted below the financial factors.
 *   commercialReliability  200  Escrow settlement record on member sales
 *                               (released vs refunded/disputed) — evidence the
 *                               institution honours commercial obligations.
 *   dataCompleteness       150  Member data coverage (complete profiles,
 *                               registered plots). Lenders cannot underwrite
 *                               what they cannot see; small weight so thin
 *                               files are discounted, not excluded.
 */
export const COOP_SCORE_WEIGHTS: Readonly<Record<CoopScoreFactorKey, number>> = {
  repaymentTrackRecord: 300,
  vslaCycleDiscipline: 200,
  governanceActivity: 150,
  commercialReliability: 200,
  dataCompleteness: 150
};

/** Composite maximum: by construction the exact sum of the factor weights. */
export const COOP_SCORE_MAX = 1000;

/** Inclusive lower score bounds for bands A-C; anything below C is D. */
export const COOP_BAND_THRESHOLDS: Readonly<Record<'A' | 'B' | 'C', number>> = {
  A: 800,
  B: 600,
  C: 400
};

export function coopScoreBand(score: number): CoopScoreBand {
  if (score >= COOP_BAND_THRESHOLDS.A) {
    return 'A';
  }
  if (score >= COOP_BAND_THRESHOLDS.B) {
    return 'B';
  }
  if (score >= COOP_BAND_THRESHOLDS.C) {
    return 'C';
  }
  return 'D';
}

/* ---------------------------------------------------- sparse thresholds --

 * A factor with fewer real observations than its minimum is capped at half
 * its weight and badged 'sparse' — bounded contribution, honestly labelled.
 */
export const COOP_MIN_LOAN_SAMPLE = 3;
export const COOP_MIN_CYCLE_SAMPLE = 2;
export const COOP_MIN_MEETING_SAMPLE = 2;
export const COOP_MIN_ESCROW_SAMPLE = 3;
export const COOP_MIN_MEMBER_SAMPLE = 3;

/** Half-weight ceiling applied to sparse factors (integer floor). */
function sparseCap(weight: number): number {
  return Math.floor(weight / 2);
}

/* ------------------------------------------------------------ factor I/O --

 * Every factor input is null when its source module was unreadable at
 * assembly time — the factor then computes as UNAVAILABLE (0 points, badge),
 * never interpolated.
 */

/** Repayment track record: kobo-weighted performance of member/group loans. */
export interface CoopRepaymentInput {
  /** Loans with at least one decided repayment obligation. */
  loansConsidered: number;
  /** Paid on or before the due date. */
  onTimeKobo: number;
  /** Paid after the due date. */
  lateKobo: number;
  /** Missed (defaulted) obligations. */
  missedKobo: number;
}

/** VSLA cycle discipline: completion plus share-out payout follow-through. */
export interface CoopVslaInput {
  cyclesTotal: number;
  cyclesClosed: number;
  /** Persisted per-member share-out plans (written before payout). */
  shareOutsPlanned: number;
  /** Share-out payouts actually completed. */
  shareOutsPaid: number;
}

/** Governance activity: chapter meeting cadence and attendance. */
export interface CoopGovernanceInput {
  /** 'meeting' events held inside the observation window. */
  meetingsHeld: number;
  attendanceTotal: number;
  rsvpTotal: number;
  /** Observation window length in days (fixed by the service). */
  windowDays: number;
}

/** Commercial reliability: escrow settlement record on member sales. */
export interface CoopCommercialInput {
  escrowsReleased: number;
  escrowsRefunded: number;
  escrowsDisputed: number;
}

/** Data completeness: member coverage of profiles and registered plots. */
export interface CoopDataInput {
  memberCount: number;
  membersWithProfile: number;
  membersWithPlot: number;
}

export interface CoopScoreInputs {
  repayment: CoopRepaymentInput | null;
  vsla: CoopVslaInput | null;
  governance: CoopGovernanceInput | null;
  commercial: CoopCommercialInput | null;
  data: CoopDataInput | null;
}

export interface CoopScoreResult {
  score: number;
  band: CoopScoreBand;
  factors: CoopScoreFactorBreakdown[];
}

/* -------------------------------------------------------- factor helpers --

 * Points math uses integer kobo/count ratios scaled by 1000 (milli-ratios)
 * with a single Math.round at the end — deterministic on every runtime.
 */

function factorResult(
  key: CoopScoreFactorKey,
  basis: CoopFactorBasis,
  rawPoints: number,
  summary: Record<string, number>
): CoopScoreFactorBreakdown {
  const weight = COOP_SCORE_WEIGHTS[key];
  let points = Math.max(0, Math.min(weight, Math.round(rawPoints)));
  if (basis === 'unavailable') {
    points = 0;
  } else if (basis === 'sparse') {
    points = Math.min(points, sparseCap(weight));
  }
  return { key, weight, points, basis, summary };
}

function unavailable(key: CoopScoreFactorKey): CoopScoreFactorBreakdown {
  return factorResult(key, 'unavailable', 0, {});
}

/** Scaled ratio points: round(weight * numerator / denominator). */
function ratioPoints(weight: number, numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return (weight * numerator) / denominator;
}

function repaymentFactor(input: CoopRepaymentInput | null): CoopScoreFactorBreakdown {
  const key = 'repaymentTrackRecord';
  if (!input) {
    return unavailable(key);
  }
  const weight = COOP_SCORE_WEIGHTS[key];
  const decidedKobo = input.onTimeKobo + input.lateKobo + input.missedKobo;
  const summary: Record<string, number> = { ...input, decidedKobo };
  if (input.loansConsidered <= 0 || decidedKobo <= 0) {
    // No decided obligations: no evidence either way — sparse zero.
    return factorResult(key, 'sparse', 0, summary);
  }
  // On-time kobo counts in full, late kobo at half, missed at zero.
  const weightedKobo = input.onTimeKobo * 1000 + input.lateKobo * 500;
  const points = ratioPoints(weight, weightedKobo, decidedKobo * 1000);
  const basis: CoopFactorBasis =
    input.loansConsidered < COOP_MIN_LOAN_SAMPLE ? 'sparse' : 'measured';
  return factorResult(key, basis, points, summary);
}

function vslaFactor(input: CoopVslaInput | null): CoopScoreFactorBreakdown {
  const key = 'vslaCycleDiscipline';
  if (!input) {
    return unavailable(key);
  }
  const weight = COOP_SCORE_WEIGHTS[key];
  const summary: Record<string, number> = { ...input };
  if (input.cyclesTotal <= 0) {
    return factorResult(key, 'sparse', 0, summary);
  }
  // Half the weight on cycle completion, half on share-out follow-through.
  const half = weight / 2;
  const completion = ratioPoints(half, input.cyclesClosed, input.cyclesTotal);
  const shareOut =
    input.shareOutsPlanned > 0
      ? ratioPoints(half, Math.min(input.shareOutsPaid, input.shareOutsPlanned), input.shareOutsPlanned)
      : 0;
  const basis: CoopFactorBasis =
    input.cyclesTotal < COOP_MIN_CYCLE_SAMPLE ? 'sparse' : 'measured';
  return factorResult(key, basis, completion + shareOut, summary);
}

function governanceFactor(input: CoopGovernanceInput | null): CoopScoreFactorBreakdown {
  const key = 'governanceActivity';
  if (!input) {
    return unavailable(key);
  }
  const weight = COOP_SCORE_WEIGHTS[key];
  const summary: Record<string, number> = { ...input };
  if (input.meetingsHeld <= 0 || input.windowDays <= 0) {
    return factorResult(key, 'sparse', 0, summary);
  }
  // Half the weight on cadence (target: one meeting per 30 days), half on
  // attendance relative to RSVPs.
  const half = weight / 2;
  const cadence = Math.min(half, ratioPoints(half, input.meetingsHeld * 30, input.windowDays));
  const attendance =
    input.rsvpTotal > 0
      ? ratioPoints(half, Math.min(input.attendanceTotal, input.rsvpTotal), input.rsvpTotal)
      : 0;
  const basis: CoopFactorBasis =
    input.meetingsHeld < COOP_MIN_MEETING_SAMPLE ? 'sparse' : 'measured';
  return factorResult(key, basis, cadence + attendance, summary);
}

function commercialFactor(input: CoopCommercialInput | null): CoopScoreFactorBreakdown {
  const key = 'commercialReliability';
  if (!input) {
    return unavailable(key);
  }
  const weight = COOP_SCORE_WEIGHTS[key];
  const resolved =
    input.escrowsReleased + input.escrowsRefunded + input.escrowsDisputed;
  const summary: Record<string, number> = { ...input, escrowsResolved: resolved };
  if (resolved <= 0) {
    return factorResult(key, 'sparse', 0, summary);
  }
  // Released counts in full, refunded at half (money returned, obligation
  // unmet), disputed at zero.
  const weighted = input.escrowsReleased * 1000 + input.escrowsRefunded * 500;
  const points = ratioPoints(weight, weighted, resolved * 1000);
  const basis: CoopFactorBasis = resolved < COOP_MIN_ESCROW_SAMPLE ? 'sparse' : 'measured';
  return factorResult(key, basis, points, summary);
}

function dataCompletenessFactor(input: CoopDataInput | null): CoopScoreFactorBreakdown {
  const key = 'dataCompleteness';
  if (!input) {
    return unavailable(key);
  }
  const weight = COOP_SCORE_WEIGHTS[key];
  const memberCount = Math.max(0, input.memberCount);
  const withProfile = Math.min(Math.max(0, input.membersWithProfile), memberCount);
  const withPlot = Math.min(Math.max(0, input.membersWithPlot), memberCount);
  const summary: Record<string, number> = {
    memberCount,
    membersWithProfile: withProfile,
    membersWithPlot: withPlot
  };
  if (memberCount <= 0) {
    return factorResult(key, 'sparse', 0, summary);
  }
  // Equal halves: complete-profile coverage and plot-registration coverage.
  const points = ratioPoints(weight, withProfile + withPlot, memberCount * 2);
  const basis: CoopFactorBasis = memberCount < COOP_MIN_MEMBER_SAMPLE ? 'sparse' : 'measured';
  return factorResult(key, basis, points, summary);
}

/* ------------------------------------------------------------ composite -- */

/**
 * Pure composite: five weighted factors, summed and clamped to 0-1000. The
 * weight-sum invariant (weights total exactly COOP_SCORE_MAX) is pinned by
 * the unit suite, so a fully-measured perfect cooperative scores 1000.
 */
export function computeCoopScore(inputs: CoopScoreInputs): CoopScoreResult {
  const factors = [
    repaymentFactor(inputs.repayment),
    vslaFactor(inputs.vsla),
    governanceFactor(inputs.governance),
    commercialFactor(inputs.commercial),
    dataCompletenessFactor(inputs.data)
  ];
  const score = Math.max(
    0,
    Math.min(
      COOP_SCORE_MAX,
      factors.reduce((total, factor) => total + factor.points, 0)
    )
  );
  return { score, band: coopScoreBand(score), factors };
}

/* --------------------------------------------------------- inputs hash -- */

/**
 * Canonical JSON: object keys sorted recursively so semantically identical
 * inputs always serialise identically (recompute idempotency).
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${canonicalStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Deterministic fingerprint of the assembled factor inputs (FNV-1a over the
 * canonical JSON, mirroring geo-credit-factor's computeInputFingerprint).
 * The service persists this as inputs_hash; recompute with an identical
 * hash appends nothing.
 */
export function computeCoopInputsHash(cooperativeId: string, inputs: CoopScoreInputs): string {
  const canonical = canonicalStringify({ cooperativeId, inputs });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
