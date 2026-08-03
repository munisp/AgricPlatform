import type { FloodSeverityRank, ParametricProduct } from '@agric-platform/shared';

/**
 * Parametric premium rate card (wave-insurance). Deterministic integer
 * arithmetic in kobo — the web quote calculator mirrors this exact math so
 * the client preview always matches the server quote (see
 * docs/parametric-insurance.md). No floats cross the boundary: rates and
 * modifiers are basis points; the final division rounds half away from zero.
 */

/** Flood-band premium modifiers in basis points (1.0 = 10_000). */
export const FLOOD_MODIFIER_BPS: Record<FloodSeverityRank, number> = {
  none: 10_000,
  low: 10_500,
  moderate: 11_250,
  high: 12_500,
  severe: 15_000
};

/** Base peril rates in basis points of the sum insured (catalog defaults). */
export const PERIL_RATE_BPS = {
  RAINFALL_DEFICIT: 800,
  FLOOD: 1_000,
  HEAT_STRESS: 600
} as const;

/** Sum-insured bounds (kobo): ₦1,000 … ₦1,000,000. */
export const MIN_SUM_INSURED_KOBO = 100_000;
export const MAX_SUM_INSURED_KOBO = 100_000_000;

/** Round half away from zero for non-negative integer numerators. */
function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * premium = sumInsured × rateBps × floodModifierBps / 10^8, rounded half-up.
 * Intermediate values stay well inside Number.MAX_SAFE_INTEGER for the
 * bounded sum-insured range (≤ 10^8 × 10^4 × 1.5×10^4 ≈ 1.5×10^16).
 */
export function computePremiumKobo(input: {
  sumInsuredKobo: number;
  premiumRateBps: number;
  floodBand: FloodSeverityRank;
}): { premiumKobo: number; floodModifierBps: number } {
  const floodModifierBps = FLOOD_MODIFIER_BPS[input.floodBand];
  const numerator = input.sumInsuredKobo * input.premiumRateBps * floodModifierBps;
  const premiumKobo = roundHalfUp(numerator, 100_000_000);
  return { premiumKobo, floodModifierBps };
}

/** Convenience: premium for a catalog product. */
export function quotePremium(
  product: Pick<ParametricProduct, 'premiumRateBps'>,
  sumInsuredKobo: number,
  floodBand: FloodSeverityRank
): { premiumKobo: number; floodModifierBps: number } {
  return computePremiumKobo({
    sumInsuredKobo,
    premiumRateBps: product.premiumRateBps,
    floodBand
  });
}
