import { describe, expect, it } from 'vitest';
import {
  applyRegenDiscountKobo,
  computePremiumKobo,
  FLOOD_MODIFIER_BPS,
  MAX_REGEN_DISCOUNT_BPS,
  MAX_SUM_INSURED_KOBO,
  MIN_PREMIUM_KOBO,
  MIN_SUM_INSURED_KOBO,
  PERIL_RATE_BPS,
  quotePremium
} from './premium.js';

/**
 * Known-answer premium vectors (wave-insurance). premium = sumInsured ×
 * rateBps × modifierBps / 10^8, rounded half away from zero.
 */
describe('parametric premium rate card', () => {
  it('prices a rainfall product at the none flood band (8% of sum insured)', () => {
    const { premiumKobo, floodModifierBps } = computePremiumKobo({
      sumInsuredKobo: 1_000_000,
      premiumRateBps: PERIL_RATE_BPS.RAINFALL_DEFICIT,
      floodBand: 'none'
    });
    expect(floodModifierBps).toBe(10_000);
    expect(premiumKobo).toBe(80_000);
  });

  it('applies the high flood-band modifier (1.25×)', () => {
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: 1_000_000,
      premiumRateBps: 800,
      floodBand: 'high'
    });
    expect(premiumKobo).toBe(100_000);
  });

  it('applies the severe flood-band modifier (1.5×)', () => {
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: 1_000_000,
      premiumRateBps: 800,
      floodBand: 'severe'
    });
    expect(premiumKobo).toBe(120_000);
  });

  it('applies the low and moderate modifiers monotonically', () => {
    const base = { sumInsuredKobo: 2_000_000, premiumRateBps: 1_000 };
    const low = computePremiumKobo({ ...base, floodBand: 'low' }).premiumKobo;
    const moderate = computePremiumKobo({ ...base, floodBand: 'moderate' }).premiumKobo;
    expect(low).toBe(210_000); // 2_000_000 × 0.10 × 1.05
    expect(moderate).toBe(225_000); // 2_000_000 × 0.10 × 1.125
    expect(moderate).toBeGreaterThan(low);
  });

  it('rounds half away from zero', () => {
    // 1_250 × 800 × 11_250 / 10^8 = 112.5 → 113
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: 1_250,
      premiumRateBps: 800,
      floodBand: 'moderate'
    });
    expect(premiumKobo).toBe(113);
  });

  it('rounds down below the half boundary', () => {
    // 1_000_005 × 800 × 11_250 / 10^8 = 90_000.45 → 90_000
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: 1_000_005,
      premiumRateBps: 800,
      floodBand: 'moderate'
    });
    expect(premiumKobo).toBe(90_000);
  });

  it('is deterministic for repeated identical inputs', () => {
    const input = { sumInsuredKobo: 3_750_000, premiumRateBps: 1_000, floodBand: 'high' as const };
    expect(computePremiumKobo(input)).toEqual(computePremiumKobo(input));
  });

  it('quotePremium mirrors computePremiumKobo for a catalog product', () => {
    const viaProduct = quotePremium({ premiumRateBps: 600 }, 500_000, 'low');
    const direct = computePremiumKobo({
      sumInsuredKobo: 500_000,
      premiumRateBps: 600,
      floodBand: 'low'
    });
    expect(viaProduct).toEqual(direct);
  });

  it('exposes the full modifier ladder and sum-insured bounds', () => {
    expect(FLOOD_MODIFIER_BPS.none).toBe(10_000);
    expect(FLOOD_MODIFIER_BPS.severe).toBeGreaterThan(FLOOD_MODIFIER_BPS.high);
    expect(MIN_SUM_INSURED_KOBO).toBe(100_000);
    expect(MAX_SUM_INSURED_KOBO).toBe(100_000_000);
  });
});

/**
 * Stage 27 (Regen Discount) known-answer vectors: the bounded, versioned
 * regen_discount_bps input, the ₦1k premium floor cap, and byte-stable
 * backwards compatibility when the discount input is omitted.
 */
describe('regen discount rate-card modifier (Stage 27)', () => {
  it('omitting regenDiscountBps reproduces the pre-existing output exactly (byte-stable)', () => {
    const input = { sumInsuredKobo: 1_000_000, premiumRateBps: 800, floodBand: 'high' as const };
    expect(computePremiumKobo(input)).toEqual({
      premiumKobo: 100_000,
      floodModifierBps: 12_500,
      regenDiscountKobo: 0
    });
  });

  it('applies the discount to the flood-adjusted premium (known answer)', () => {
    // 2_000_000 × 800 × 10_000 / 10^8 = 160_000; 160_000 × 1_000 / 10_000 = 16_000 discount.
    const result = computePremiumKobo({
      sumInsuredKobo: 2_000_000,
      premiumRateBps: PERIL_RATE_BPS.RAINFALL_DEFICIT,
      floodBand: 'none',
      regenDiscountBps: 1_000
    });
    expect(result).toEqual({ premiumKobo: 144_000, floodModifierBps: 10_000, regenDiscountKobo: 16_000 });
  });

  it('rounds the discount half away from zero', () => {
    // Floor-clear exact case: 12_500_000 × 800 × 10_000 / 10^8 = 1_000_000;
    // 1_000_000 × 1_225 / 10_000 = 122_500 exactly.
    const exact = computePremiumKobo({
      sumInsuredKobo: 12_500_000,
      premiumRateBps: 800,
      floodBand: 'none',
      regenDiscountBps: 1_225
    });
    expect(exact).toEqual({ premiumKobo: 877_500, floodModifierBps: 10_000, regenDiscountKobo: 122_500 });
    // Half-rounding: 1_000_001 × 5 / 10_000 = 500.0005 → 500.
    const half = applyRegenDiscountKobo(1_000_001, 5);
    expect(half).toEqual({ premiumKobo: 999_501, regenDiscountKobo: 500 });
  });

  it('caps the discount so the premium never drops below the ₦1k floor', () => {
    // Premium 150_000 (₦1,500), 50% discount = 75_000 would land at 75_000 < 100_000 floor → capped to 50_000.
    const capped = computePremiumKobo({
      sumInsuredKobo: 1_875_000,
      premiumRateBps: 800,
      floodBand: 'none',
      regenDiscountBps: MAX_REGEN_DISCOUNT_BPS
    });
    expect(capped.premiumKobo).toBe(MIN_PREMIUM_KOBO);
    expect(capped.regenDiscountKobo).toBe(150_000 - MIN_PREMIUM_KOBO);
  });

  it('a premium at or below the floor earns no discount at all', () => {
    expect(applyRegenDiscountKobo(100_000, 5_000)).toEqual({ premiumKobo: 100_000, regenDiscountKobo: 0 });
    expect(applyRegenDiscountKobo(80_000, 5_000)).toEqual({ premiumKobo: 80_000, regenDiscountKobo: 0 });
  });

  it('rejects out-of-bounds discount bps (bounded modifier)', () => {
    expect(() => applyRegenDiscountKobo(1_000_000, -1)).toThrow(RangeError);
    expect(() => applyRegenDiscountKobo(1_000_000, MAX_REGEN_DISCOUNT_BPS + 1)).toThrow(RangeError);
    expect(() => applyRegenDiscountKobo(1_000_000, 1.5)).toThrow(RangeError);
    expect(() =>
      computePremiumKobo({
        sumInsuredKobo: 1_000_000,
        premiumRateBps: 800,
        floodBand: 'none',
        regenDiscountBps: 10_000
      })
    ).toThrow(RangeError);
  });

  it('is deterministic (byte-stable) for identical discounted inputs', () => {
    const input = {
      sumInsuredKobo: 3_750_000,
      premiumRateBps: 1_000,
      floodBand: 'high' as const,
      regenDiscountBps: 750
    };
    expect(computePremiumKobo(input)).toEqual(computePremiumKobo(input));
  });
});
