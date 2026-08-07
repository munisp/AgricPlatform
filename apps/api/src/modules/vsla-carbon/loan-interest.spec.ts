import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  MAX_VSLA_INTEREST_RATE_BPS,
  simpleInterestKobo,
  totalDueKobo
} from './loan-interest.js';

describe('simple-interest VSLA loan math', () => {
  it('computes flat simple interest over the term (10% = 1000 bps)', () => {
    expect(simpleInterestKobo(50_000, 1_000)).toBe(5_000);
    expect(totalDueKobo(50_000, 1_000)).toBe(55_000);
  });

  it('floors sub-kobo interest deterministically', () => {
    // 101 * 333 / 10000 = 3.3633 → 3
    expect(simpleInterestKobo(101, 333)).toBe(3);
    expect(totalDueKobo(101, 333)).toBe(104);
  });

  it('supports zero-interest loans', () => {
    expect(simpleInterestKobo(100_000, 0)).toBe(0);
    expect(totalDueKobo(100_000, 0)).toBe(100_000);
  });

  it('enforces the usury guard (max flat rate)', () => {
    expect(() => simpleInterestKobo(10_000, MAX_VSLA_INTEREST_RATE_BPS + 1)).toThrow(
      BadRequestException
    );
    expect(simpleInterestKobo(10_000, MAX_VSLA_INTEREST_RATE_BPS)).toBe(3_000);
  });

  it('rejects non-positive or fractional principals', () => {
    expect(() => simpleInterestKobo(0, 500)).toThrow(BadRequestException);
    expect(() => simpleInterestKobo(-5, 500)).toThrow(BadRequestException);
    expect(() => simpleInterestKobo(10.5, 500)).toThrow(BadRequestException);
  });

  it('is deterministic across calls', () => {
    expect(totalDueKobo(123_456, 750)).toBe(totalDueKobo(123_456, 750));
  });
});
