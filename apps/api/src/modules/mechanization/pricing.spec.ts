import { describe, expect, it } from 'vitest';
import type { EquipmentRates } from '@agric-platform/shared';
import {
  computeQuote,
  haversineKm,
  SEASONAL_MULTIPLIERS,
  seasonalMultiplierForMonth
} from './pricing.js';

const PER_HA_RATES: EquipmentRates = { perHaNaira: 25000, perKmNaira: 500, includedKm: 20 };

describe('haversineKm (hand-computed references)', () => {
  it('returns 0 for the same point', () => {
    expect(haversineKm(9.0574, 7.4951, 9.0574, 7.4951)).toBe(0);
  });

  it('matches the hand-computed 1°-latitude great-circle distance', () => {
    // 1° of latitude = 111.1949 km on the R=6371 km sphere (computed by hand).
    expect(haversineKm(9.0, 8.0, 10.0, 8.0)).toBeCloseTo(111.1949, 3);
  });

  it('matches the hand-computed Kano → Kaduna distance', () => {
    // Kano (12.0022, 8.5920) → Kaduna (10.5105, 7.4165) = 209.6322 km.
    expect(haversineKm(12.0022, 8.592, 10.5105, 7.4165)).toBeCloseTo(209.6322, 3);
  });

  it('is symmetric', () => {
    const ab = haversineKm(12.0022, 8.592, 10.5105, 7.4165);
    const ba = haversineKm(10.5105, 7.4165, 12.0022, 8.592);
    expect(ab).toBeCloseTo(ba, 9);
  });
});

describe('computeQuote known-answer vectors', () => {
  it('computes area component + distance surcharge + April multiplier', () => {
    const quote = computeQuote({
      rates: PER_HA_RATES,
      areaHa: 3.5,
      distanceKm: 50,
      windowStart: '2026-04-10T08:00:00.000Z',
      quotedAt: '2026-03-01T00:00:00.000Z'
    });
    // area: 3.5 ha × ₦25,000 = ₦87,500 = 8,750,000 kobo
    expect(quote.areaComponentKobo).toBe(8_750_000);
    expect(quote.hourComponentKobo).toBe(0);
    // surcharge: (50 − 20) km × ₦500 = ₦15,000 = 1,500,000 kobo
    expect(quote.distanceSurchargeKobo).toBe(1_500_000);
    expect(quote.subtotalKobo).toBe(10_250_000);
    // April multiplier 1.3 → 13,325,000 kobo
    expect(quote.seasonalMultiplier).toBe(1.3);
    expect(quote.seasonalMonth).toBe(4);
    expect(quote.totalKobo).toBe(13_325_000);
  });

  it('charges no surcharge when distance is within the included radius', () => {
    const quote = computeQuote({
      rates: PER_HA_RATES,
      areaHa: 2,
      distanceKm: 15,
      windowStart: '2026-08-10T08:00:00.000Z'
    });
    expect(quote.distanceSurchargeKobo).toBe(0);
    // August multiplier 1.0 → total equals base
    expect(quote.totalKobo).toBe(5_000_000);
  });

  it('boundary: distance exactly equal to includedKm surcharges zero', () => {
    const quote = computeQuote({
      rates: PER_HA_RATES,
      areaHa: 1,
      distanceKm: 20,
      windowStart: '2026-08-01T00:00:00.000Z'
    });
    expect(quote.distanceSurchargeKobo).toBe(0);
  });

  it('computes the hour component for per-hour listings', () => {
    const quote = computeQuote({
      rates: { perHourNaira: 12000, perKmNaira: 0, includedKm: 0 },
      areaHa: 1.2,
      estimatedHours: 6,
      distanceKm: 0,
      windowStart: '2026-11-15T08:00:00.000Z'
    });
    expect(quote.areaComponentKobo).toBe(0);
    // 6 h × ₦12,000 = ₦72,000 = 7,200,000 kobo; November 1.25 → 9,000,000
    expect(quote.hourComponentKobo).toBe(7_200_000);
    expect(quote.totalKobo).toBe(9_000_000);
  });

  it('sums both components when a listing bills per_ha AND per_hour', () => {
    const quote = computeQuote({
      rates: { perHaNaira: 10000, perHourNaira: 5000, perKmNaira: 100, includedKm: 0 },
      areaHa: 2,
      estimatedHours: 3,
      distanceKm: 10,
      windowStart: '2026-08-01T00:00:00.000Z'
    });
    expect(quote.areaComponentKobo).toBe(2_000_000);
    expect(quote.hourComponentKobo).toBe(1_500_000);
    expect(quote.distanceSurchargeKobo).toBe(100_000);
    expect(quote.totalKobo).toBe(3_600_000); // August × 1.0
  });

  it('rounds fractional-kobo products deterministically', () => {
    const quote = computeQuote({
      rates: { perHaNaira: 333.33, perKmNaira: 0, includedKm: 0 },
      areaHa: 0.7,
      distanceKm: 0,
      windowStart: '2026-08-01T00:00:00.000Z'
    });
    // 0.7 × 33,333 kobo = 23,333.1 → 23,333 kobo
    expect(quote.areaComponentKobo).toBe(23_333);
    expect(Number.isSafeInteger(quote.totalKobo)).toBe(true);
  });

  it('applies each month’s multiplier from the static table', () => {
    expect(seasonalMultiplierForMonth(5)).toBe(1.3);
    expect(seasonalMultiplierForMonth(8)).toBe(1.0);
    expect(seasonalMultiplierForMonth(11)).toBe(1.25);
    expect(Object.keys(SEASONAL_MULTIPLIERS)).toHaveLength(12);
    expect(() => seasonalMultiplierForMonth(13)).toThrow(RangeError);
  });

  it('selects the multiplier from the window START month, not quote time', () => {
    const quote = computeQuote({
      rates: { perHaNaira: 1000, perKmNaira: 0, includedKm: 0 },
      areaHa: 1,
      distanceKm: 0,
      windowStart: '2026-12-20T00:00:00.000Z',
      quotedAt: '2026-05-01T00:00:00.000Z'
    });
    expect(quote.seasonalMonth).toBe(12);
    expect(quote.seasonalMultiplier).toBe(1.15);
  });

  it('rejects listings with no usable rate', () => {
    expect(() =>
      computeQuote({
        rates: { perKmNaira: 100, includedKm: 0 },
        areaHa: 1,
        distanceKm: 0,
        windowStart: '2026-08-01T00:00:00.000Z'
      })
    ).toThrow(RangeError);
  });

  it('requires estimatedHours when billing per_hour', () => {
    expect(() =>
      computeQuote({
        rates: { perHourNaira: 5000, perKmNaira: 0, includedKm: 0 },
        areaHa: 1,
        distanceKm: 0,
        windowStart: '2026-08-01T00:00:00.000Z'
      })
    ).toThrow(/estimatedHours/);
  });

  it('rejects non-positive area', () => {
    expect(() =>
      computeQuote({
        rates: PER_HA_RATES,
        areaHa: 0,
        distanceKm: 10,
        windowStart: '2026-08-01T00:00:00.000Z'
      })
    ).toThrow(RangeError);
  });
});
