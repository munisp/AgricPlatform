import { describe, expect, it } from 'vitest';
import { cancellationSplit } from './cancellation.js';

const WINDOW_START = '2026-09-10T08:00:00.000Z';
const startMs = Date.parse(WINDOW_START);
const hours = (h: number): number => startMs - h * 60 * 60 * 1000;

describe('cancellationSplit — deterministic hold-release schedule', () => {
  it('owner cancel → 100% refund regardless of timing', () => {
    const split = cancellationSplit(100_000, 'owner', WINDOW_START, hours(1));
    expect(split).toEqual({
      refundToFarmerKobo: 100_000,
      compensationToOwnerKobo: 0,
      rule: 'owner_cancel_full_refund'
    });
  });

  it('admin cancel → 100% refund regardless of timing', () => {
    const split = cancellationSplit(100_000, 'admin', WINDOW_START, hours(0.5));
    expect(split.rule).toBe('admin_cancel_full_refund');
    expect(split.refundToFarmerKobo).toBe(100_000);
  });

  it('farmer ≥48h before → 100% refund', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, hours(72));
    expect(split).toEqual({
      refundToFarmerKobo: 100_000,
      compensationToOwnerKobo: 0,
      rule: 'farmer_free_cancel'
    });
  });

  it('boundary: exactly 48h before is still a free cancel', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, hours(48));
    expect(split.rule).toBe('farmer_free_cancel');
  });

  it('farmer 24–48h before → 90% farmer / 10% owner', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, hours(30));
    expect(split.rule).toBe('farmer_late_cancel_90_10');
    expect(split.refundToFarmerKobo).toBe(90_000);
    expect(split.compensationToOwnerKobo).toBe(10_000);
  });

  it('boundary: exactly 24h before falls in the 90/10 band', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, hours(24));
    expect(split.rule).toBe('farmer_late_cancel_90_10');
  });

  it('farmer <24h before (or in service) → 70% farmer / 30% owner', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, hours(2));
    expect(split.rule).toBe('farmer_very_late_cancel_70_30');
    expect(split.refundToFarmerKobo).toBe(70_000);
    expect(split.compensationToOwnerKobo).toBe(30_000);
  });

  it('after the window has started, farmer cancel is still the 70/30 row', () => {
    const split = cancellationSplit(100_000, 'farmer', WINDOW_START, startMs + 3_600_000);
    expect(split.rule).toBe('farmer_very_late_cancel_70_30');
  });

  it('conserves kobo exactly on odd totals (owner rounded, farmer remainder)', () => {
    const split = cancellationSplit(99_999, 'farmer', WINDOW_START, hours(30));
    expect(split.refundToFarmerKobo + split.compensationToOwnerKobo).toBe(99_999);
    expect(split.compensationToOwnerKobo).toBe(10_000); // round(99_999 × 0.1)
    expect(split.refundToFarmerKobo).toBe(89_999);
  });

  it('rejects negative totals', () => {
    expect(() => cancellationSplit(-1, 'owner', WINDOW_START, hours(1))).toThrow(RangeError);
  });
});
