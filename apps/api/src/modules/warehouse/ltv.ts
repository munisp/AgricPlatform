/**
 * Pure loan-to-value computation for receipt-backed collateral (Stage 27 /
 * Innovation 8). Deterministic, integer-kobo, float-free output in basis
 * points — the same inputs always produce the same ltv_bps (known-answer
 * testable like finance/premium math).
 *
 *   effective collateral = pledgedQtyKg × pricePerKgKobo × (1 − haircut)
 *   ltv_bps              = outstandingKobo ÷ effective collateral × 10000
 *
 * The outstanding balance is an INPUT here: callers must read it from the
 * finance ledger (single source of truth), never from a parallel table.
 */

export const BPS_DENOMINATOR = 10_000;

export interface LtvInput {
  /** Pledged collateral quantity in kilograms (> 0). */
  pledgedQtyKg: number;
  /** Observed price per kilogram in integer kobo (> 0). */
  pricePerKgKobo: number;
  /** Collateral haircut in basis points, 0–9999 (10000 would zero the value). */
  haircutBps: number;
  /** Outstanding loan balance in integer kobo, read from the ledger (≥ 0). */
  outstandingKobo: number;
}

/** Thrown when an LTV input is outside its domain — fail loud, never guess. */
export class LtvInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LtvInputError';
  }
}

/**
 * Computes the loan-to-value ratio in integer basis points.
 * Rounds half-up to the nearest bp; an outstanding of 0 yields 0.
 */
export function computeLtvBps(input: LtvInput): number {
  const { pledgedQtyKg, pricePerKgKobo, haircutBps, outstandingKobo } = input;
  if (!Number.isFinite(pledgedQtyKg) || pledgedQtyKg <= 0) {
    throw new LtvInputError('pledgedQtyKg must be a positive finite number');
  }
  if (!Number.isSafeInteger(pricePerKgKobo) || pricePerKgKobo <= 0) {
    throw new LtvInputError('pricePerKgKobo must be a positive integer (kobo)');
  }
  if (!Number.isSafeInteger(haircutBps) || haircutBps < 0 || haircutBps >= BPS_DENOMINATOR) {
    throw new LtvInputError('haircutBps must be an integer between 0 and 9999');
  }
  if (!Number.isSafeInteger(outstandingKobo) || outstandingKobo < 0) {
    throw new LtvInputError('outstandingKobo must be a non-negative integer (kobo)');
  }
  if (outstandingKobo === 0) {
    return 0;
  }
  const grossKobo = pledgedQtyKg * pricePerKgKobo;
  const effectiveKobo = (grossKobo * (BPS_DENOMINATOR - haircutBps)) / BPS_DENOMINATOR;
  // effectiveKobo > 0 is guaranteed: qty > 0, price ≥ 1, haircut ≤ 9999.
  return Math.round((outstandingKobo * BPS_DENOMINATOR) / effectiveKobo);
}

/** Risk band of an observed LTV against the position's thresholds. */
export type LtvBand = 'within_limit' | 'watch' | 'margin_call';

/**
 * Classifies an observed ltv_bps:
 *   ltv ≥ margin_call_bps            → 'margin_call' (breach)
 *   ltv_limit_bps < ltv < margin     → 'watch' (eroded, no call yet)
 *   ltv ≤ ltv_limit_bps              → 'within_limit' (healthy / cure zone)
 * The band between limit and margin-call is a hysteresis zone so a position
 * hovering near the limit does not flap between states.
 */
export function classifyLtv(
  ltvBps: number,
  ltvLimitBps: number,
  marginCallBps: number
): LtvBand {
  if (ltvBps >= marginCallBps) {
    return 'margin_call';
  }
  if (ltvBps > ltvLimitBps) {
    return 'watch';
  }
  return 'within_limit';
}

/**
 * Converts a provider quote (naira per tonne) into integer kobo per
 * kilogram: ₦/t × 100 kobo/₦ ÷ 1000 kg/t, rounded to the nearest kobo.
 */
export function nairaPerTonneToKoboPerKg(pricePerTonneNaira: number): number {
  if (!Number.isFinite(pricePerTonneNaira) || pricePerTonneNaira <= 0) {
    throw new LtvInputError('pricePerTonneNaira must be a positive finite number');
  }
  const koboPerKg = Math.round((pricePerTonneNaira * 100) / 1000);
  if (koboPerKg <= 0) {
    throw new LtvInputError('pricePerTonneNaira rounds to zero kobo per kilogram');
  }
  return koboPerKg;
}
