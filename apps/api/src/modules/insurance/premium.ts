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

/**
 * Premium floor (kobo): ₦1,000 — the rate card's ₦1k floor denomination
 * (same figure as MIN_SUM_INSURED_KOBO) applied to the premium itself.
 * Stage 27 (Regen Discount): the discount is capped so the discounted
 * premium never drops below this floor.
 */
export const MIN_PREMIUM_KOBO = 100_000;

/**
 * Regen-discount bound (Stage 27, innovation 12): the MRV-verified premium
 * discount is a bounded, versioned rate-card modifier like the flood bands
 * — at most 50% of the computed premium (5_000 bps), mirrored by the
 * CHECK constraint in migration 070.
 */
export const MAX_REGEN_DISCOUNT_BPS = 5_000;

/** Round half away from zero for non-negative integer numerators. */
function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * Stage 27 (Regen Discount): applies the bounded, versioned regen discount
 * to a computed premium. discount = premium × bps / 10^4, rounded half-up,
 * then capped so the discounted premium never drops below the ₦1k floor
 * (MIN_PREMIUM_KOBO) — a premium already at or below the floor earns no
 * discount at all. Pure integer arithmetic: byte-stable for identical
 * inputs.
 */
export function applyRegenDiscountKobo(
  premiumKobo: number,
  regenDiscountBps: number
): { premiumKobo: number; regenDiscountKobo: number } {
  if (
    !Number.isSafeInteger(regenDiscountBps) ||
    regenDiscountBps < 0 ||
    regenDiscountBps > MAX_REGEN_DISCOUNT_BPS
  ) {
    throw new RangeError(
      `regenDiscountBps must be an integer between 0 and ${MAX_REGEN_DISCOUNT_BPS}`
    );
  }
  if (regenDiscountBps === 0 || premiumKobo <= MIN_PREMIUM_KOBO) {
    return { premiumKobo, regenDiscountKobo: 0 };
  }
  const rawDiscountKobo = roundHalfUp(premiumKobo * regenDiscountBps, 10_000);
  const regenDiscountKobo = Math.min(rawDiscountKobo, premiumKobo - MIN_PREMIUM_KOBO);
  return { premiumKobo: premiumKobo - regenDiscountKobo, regenDiscountKobo };
}

/**
 * premium = sumInsured × rateBps × floodModifierBps / 10^8, rounded half-up.
 * Intermediate values stay well inside Number.MAX_SAFE_INTEGER for the
 * bounded sum-insured range (≤ 10^8 × 10^4 × 1.5×10^4 ≈ 1.5×10^16).
 *
 * Stage 27 (Regen Discount): the optional `regenDiscountBps` input is the
 * bounded (0..MAX_REGEN_DISCOUNT_BPS), versioned MRV-linked discount; when
 * present the result carries `regenDiscountKobo` and `premiumKobo` is the
 * discounted, floor-capped figure. Omitting it reproduces the pre-existing
 * byte-stable outputs exactly (regenDiscountKobo = 0).
 */
export function computePremiumKobo(input: {
  sumInsuredKobo: number;
  premiumRateBps: number;
  floodBand: FloodSeverityRank;
  regenDiscountBps?: number;
}): { premiumKobo: number; floodModifierBps: number; regenDiscountKobo: number } {
  const floodModifierBps = FLOOD_MODIFIER_BPS[input.floodBand];
  const numerator = input.sumInsuredKobo * input.premiumRateBps * floodModifierBps;
  const basePremiumKobo = roundHalfUp(numerator, 100_000_000);
  if (input.regenDiscountBps === undefined) {
    return { premiumKobo: basePremiumKobo, floodModifierBps, regenDiscountKobo: 0 };
  }
  const discounted = applyRegenDiscountKobo(basePremiumKobo, input.regenDiscountBps);
  return {
    premiumKobo: discounted.premiumKobo,
    floodModifierBps,
    regenDiscountKobo: discounted.regenDiscountKobo
  };
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
