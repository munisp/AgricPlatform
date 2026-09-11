import { describe, expect, it } from 'vitest';
import { commissionFor } from './commission.js';

describe('agent commission table', () => {
  it('computes basis points of the amount, floored to kobo', () => {
    // cash_in: 50 bps = 0.50%.
    expect(commissionFor('cash_in', 100_000)).toBe(500);
    expect(commissionFor('cash_in', 199)).toBe(0); // floor of 0.995
    // cash_out: 75 bps = 0.75%.
    expect(commissionFor('cash_out', 100_000)).toBe(750);
    // voucher_redemption: 25 bps = 0.25%.
    expect(commissionFor('voucher_redemption', 100_000)).toBe(250);
  });

  it('caps the per-transaction commission', () => {
    // N500,000 cash-in → raw 250,000 kobo, capped at 50,000 (N500).
    expect(commissionFor('cash_in', 50_000_000)).toBe(50_000);
    // cash_out: raw 375,000 kobo at 75 bps, capped at 75,000 (N750).
    expect(commissionFor('cash_out', 50_000_000)).toBe(75_000);
    // voucher_redemption: raw 125,000 kobo at 25 bps, capped at 25,000 (N250).
    expect(commissionFor('voucher_redemption', 50_000_000)).toBe(25_000);
  });

  it('is exactly at the cap boundary', () => {
    // cap 50,000 kobo at 50 bps is reached at exactly 10,000,000 kobo.
    expect(commissionFor('cash_in', 10_000_000)).toBe(50_000);
    expect(commissionFor('cash_in', 10_000_100)).toBe(50_000);
  });

  it('is deterministic (same inputs, same output)', () => {
    expect(commissionFor('cash_out', 1_234_567)).toBe(commissionFor('cash_out', 1_234_567));
  });

  it('returns 0 for non-positive or unsafe amounts', () => {
    expect(commissionFor('cash_in', 0)).toBe(0);
    expect(commissionFor('cash_in', -500)).toBe(0);
    expect(commissionFor('cash_in', 1.5)).toBe(0);
    expect(commissionFor('cash_in', Number.MAX_SAFE_INTEGER + 1)).toBe(0);
  });
});
