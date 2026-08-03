import { describe, expect, it } from 'vitest';
import {
  computePremiumKobo,
  FLOOD_MODIFIER_BPS,
  MAX_SUM_INSURED_KOBO,
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
