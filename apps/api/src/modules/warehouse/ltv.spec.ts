import { describe, expect, it } from 'vitest';
import {
  BPS_DENOMINATOR,
  classifyLtv,
  computeLtvBps,
  LtvInputError,
  nairaPerTonneToKoboPerKg
} from './ltv.js';

/**
 * Known-answer vectors for the pure LTV math (Stage 27 / Innovation 8).
 * Every expected value below is derived by hand:
 *   ltv_bps = round(outstanding × 10000 / (qty × price × (1 − haircut))).
 */
describe('computeLtvBps — known answers', () => {
  it('computes a 50% LTV with no haircut', () => {
    // gross = 1000 × 1000 = 1,000,000 kobo; 500,000 / 1,000,000 = 50%.
    expect(
      computeLtvBps({
        pledgedQtyKg: 1000,
        pricePerKgKobo: 1000,
        haircutBps: 0,
        outstandingKobo: 500_000
      })
    ).toBe(5000);
  });

  it('applies the haircut before dividing', () => {
    // gross = 2000 × 25,000 = 50,000,000; × 0.8 = 40,000,000;
    // 300,000 / 40,000,000 = 0.0075 → 75 bps.
    expect(
      computeLtvBps({
        pledgedQtyKg: 2000,
        pricePerKgKobo: 25_000,
        haircutBps: 2000,
        outstandingKobo: 300_000
      })
    ).toBe(75);
  });

  it('computes a breaching LTV exactly (no rounding drift)', () => {
    // gross = 2000 × 200 = 400,000; × 0.8 = 320,000;
    // 300,000 / 320,000 = 0.9375 → 9375 bps exactly.
    expect(
      computeLtvBps({
        pledgedQtyKg: 2000,
        pricePerKgKobo: 200,
        haircutBps: 2000,
        outstandingKobo: 300_000
      })
    ).toBe(9375);
  });

  it('returns 0 when the loan is fully repaid', () => {
    expect(
      computeLtvBps({
        pledgedQtyKg: 500,
        pricePerKgKobo: 900,
        haircutBps: 1500,
        outstandingKobo: 0
      })
    ).toBe(0);
  });

  it('rounds half-up to the nearest basis point', () => {
    // eff = 3 × 1000 = 3000; 1 / 3000 × 10000 = 3.333… → 3 bps.
    expect(
      computeLtvBps({
        pledgedQtyKg: 3,
        pricePerKgKobo: 1000,
        haircutBps: 0,
        outstandingKobo: 1
      })
    ).toBe(3);
  });

  it('supports fractional kilogram quantities', () => {
    // gross = 0.5 × 40,000 = 20,000; × 0.9 = 18,000; 9,000 / 18,000 = 50%.
    expect(
      computeLtvBps({
        pledgedQtyKg: 0.5,
        pricePerKgKobo: 40_000,
        haircutBps: 1000,
        outstandingKobo: 9000
      })
    ).toBe(5000);
  });
});

describe('computeLtvBps — haircut edge cases', () => {
  it('haircut 0 bps values collateral at gross', () => {
    expect(
      computeLtvBps({
        pledgedQtyKg: 100,
        pricePerKgKobo: 500,
        haircutBps: 0,
        outstandingKobo: 25_000
      })
    ).toBe(5000);
  });

  it('haircut 9999 bps leaves a sliver of collateral value', () => {
    // eff = 1 × 10,000 × (1/10000) = 1 kobo; 1 / 1 × 10000 = 10,000 bps.
    expect(
      computeLtvBps({
        pledgedQtyKg: 1,
        pricePerKgKobo: 10_000,
        haircutBps: 9999,
        outstandingKobo: 1
      })
    ).toBe(BPS_DENOMINATOR);
  });

  it('rejects a 100% haircut (collateral would be worthless)', () => {
    expect(() =>
      computeLtvBps({
        pledgedQtyKg: 1,
        pricePerKgKobo: 10_000,
        haircutBps: 10_000,
        outstandingKobo: 1
      })
    ).toThrow(LtvInputError);
  });

  it('rejects a negative haircut', () => {
    expect(() =>
      computeLtvBps({
        pledgedQtyKg: 1,
        pricePerKgKobo: 10_000,
        haircutBps: -1,
        outstandingKobo: 1
      })
    ).toThrow(LtvInputError);
  });
});

describe('computeLtvBps — input validation (fail loud)', () => {
  const base = {
    pledgedQtyKg: 100,
    pricePerKgKobo: 500,
    haircutBps: 1000,
    outstandingKobo: 10_000
  };

  it('rejects non-positive or non-finite quantities', () => {
    for (const pledgedQtyKg of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeLtvBps({ ...base, pledgedQtyKg })).toThrow(LtvInputError);
    }
  });

  it('rejects non-positive, fractional or unsafe prices', () => {
    for (const pricePerKgKobo of [0, -5, 1.5, Number.NaN]) {
      expect(() => computeLtvBps({ ...base, pricePerKgKobo })).toThrow(LtvInputError);
    }
  });

  it('rejects negative or fractional outstanding balances', () => {
    for (const outstandingKobo of [-1, 2.5, Number.NaN]) {
      expect(() => computeLtvBps({ ...base, outstandingKobo })).toThrow(LtvInputError);
    }
  });
});

describe('classifyLtv — threshold bands', () => {
  const limit = 6000;
  const margin = 8000;

  it('at or below the limit is within_limit (the cure zone)', () => {
    expect(classifyLtv(469, limit, margin)).toBe('within_limit');
    expect(classifyLtv(limit, limit, margin)).toBe('within_limit');
  });

  it('between limit and margin-call is the watch hysteresis band', () => {
    expect(classifyLtv(6001, limit, margin)).toBe('watch');
    expect(classifyLtv(7999, limit, margin)).toBe('watch');
  });

  it('at or above the margin-call threshold is margin_call', () => {
    expect(classifyLtv(margin, limit, margin)).toBe('margin_call');
    expect(classifyLtv(9375, limit, margin)).toBe('margin_call');
  });
});

describe('nairaPerTonneToKoboPerKg — unit conversion', () => {
  it('converts ₦/tonne to kobo/kg (× 100 ÷ 1000)', () => {
    expect(nairaPerTonneToKoboPerKg(250_000)).toBe(25_000);
    expect(nairaPerTonneToKoboPerKg(2000)).toBe(200);
  });

  it('rounds to the nearest kobo', () => {
    // 5 ₦/t → 0.5 kobo/kg → 1.
    expect(nairaPerTonneToKoboPerKg(5)).toBe(1);
  });

  it('rejects non-positive prices and prices that round to zero', () => {
    for (const price of [0, -100, Number.NaN]) {
      expect(() => nairaPerTonneToKoboPerKg(price)).toThrow(LtvInputError);
    }
    // 1 ₦/t → 0.1 kobo/kg → rounds to 0 → unusable.
    expect(() => nairaPerTonneToKoboPerKg(1)).toThrow(LtvInputError);
  });
});
