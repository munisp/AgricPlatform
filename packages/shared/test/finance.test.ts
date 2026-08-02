import { describe, expect, it } from 'vitest';
import {
  addMonthsIso,
  computeCreditScore,
  computeVatKobo,
  CREDIT_SCORE_VERSION,
  generateAmortisationSchedule,
  VAT_RATE_BPS
} from '../src/finance.js';

describe('computeVatKobo', () => {
  it('applies the 7.5% Nigeria VAT rate in integer kobo', () => {
    expect(VAT_RATE_BPS).toBe(750);
    expect(computeVatKobo(100_000)).toBe(7_500);
    expect(computeVatKobo(37_000_000)).toBe(2_775_000);
  });

  it('rounds to the nearest kobo without floats', () => {
    expect(computeVatKobo(1)).toBe(0); // 0.075 kobo rounds down
    expect(computeVatKobo(7)).toBe(1); // 0.525 kobo rounds up
    expect(Number.isInteger(computeVatKobo(123_457))).toBe(true);
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => computeVatKobo(1.5)).toThrow(/integer kobo/);
    expect(() => computeVatKobo(-100)).toThrow(/integer kobo/);
  });
});

describe('addMonthsIso', () => {
  it('steps monthly and clamps to month end', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-03-15', 2)).toBe('2026-05-15');
    expect(addMonthsIso('2026-12-10', 1)).toBe('2027-01-10');
  });
});

describe('generateAmortisationSchedule', () => {
  it('splits zero-interest principal into equal kobo installments', () => {
    const schedule = generateAmortisationSchedule({
      principalKobo: 100_000,
      annualRateBps: 0,
      termMonths: 3,
      firstDueDate: '2026-08-01'
    });
    expect(schedule).toHaveLength(3);
    expect(schedule.map((i) => i.totalKobo)).toEqual([33_333, 33_333, 33_334]);
    expect(schedule.reduce((sum, i) => sum + i.principalKobo, 0)).toBe(100_000);
    expect(schedule.every((i) => i.interestKobo === 0)).toBe(true);
  });

  it('produces constant payments with the final installment absorbing rounding', () => {
    const schedule = generateAmortisationSchedule({
      principalKobo: 10_000_000, // ₦100,000
      annualRateBps: 1200, // 12% p.a. = 1% per month
      termMonths: 12,
      firstDueDate: '2026-08-15'
    });
    expect(schedule).toHaveLength(12);
    // Annuity payment for ₦100,000 @ 1%/month over 12 months ≈ ₦8,884.88.
    expect(schedule[0].totalKobo).toBe(888_488);
    // First month interest = 1% of ₦100,000 = ₦1,000; interest declines after.
    expect(schedule[0].interestKobo).toBe(100_000);
    expect(schedule[11].interestKobo).toBeLessThan(schedule[0].interestKobo);
    // Invariants: principal fully repaid, all integer kobo, totals consistent.
    expect(schedule.reduce((sum, i) => sum + i.principalKobo, 0)).toBe(10_000_000);
    for (const installment of schedule) {
      expect(Number.isInteger(installment.principalKobo)).toBe(true);
      expect(Number.isInteger(installment.interestKobo)).toBe(true);
      expect(installment.totalKobo).toBe(installment.principalKobo + installment.interestKobo);
    }
    expect(schedule[0].dueDate).toBe('2026-08-15');
    expect(schedule[11].dueDate).toBe('2027-07-15');
  });

  it('is deterministic across runs', () => {
    const input = { principalKobo: 5_555_555, annualRateBps: 2750, termMonths: 7, firstDueDate: '2026-09-30' };
    expect(generateAmortisationSchedule(input)).toEqual(generateAmortisationSchedule(input));
  });

  it('rejects invalid input', () => {
    expect(() =>
      generateAmortisationSchedule({ principalKobo: -1, annualRateBps: 0, termMonths: 3, firstDueDate: '2026-08-01' })
    ).toThrow(/integer kobo/);
    expect(() =>
      generateAmortisationSchedule({ principalKobo: 100, annualRateBps: 100, termMonths: 0, firstDueDate: '2026-08-01' })
    ).toThrow(/termMonths/);
    expect(() =>
      generateAmortisationSchedule({ principalKobo: 100, annualRateBps: 100, termMonths: 3, firstDueDate: '01/08/2026' })
    ).toThrow(/ISO date/);
  });
});

describe('computeCreditScore (credit-score/v1)', () => {
  const zero = {
    completedCourses: 0,
    completedOrders: 0,
    repaidLoans: 0,
    defaultedLoans: 0,
    onTimeRepayments: 0,
    lateRepayments: 0,
    verifiedDocuments: 0
  };

  it('is versioned and deterministic', () => {
    expect(CREDIT_SCORE_VERSION).toBe('credit-score/v1');
    const signals = { ...zero, completedCourses: 3, completedOrders: 4, verifiedDocuments: 2 };
    expect(computeCreditScore(signals)).toEqual(computeCreditScore(signals));
  });

  it('rewards platform signals within component caps', () => {
    expect(computeCreditScore(zero).score).toBe(10);
    const rich = computeCreditScore({
      completedCourses: 10, // capped at 30
      completedOrders: 10, // capped at 25
      repaidLoans: 3,
      defaultedLoans: 0,
      onTimeRepayments: 12, // capped with loans at 25
      lateRepayments: 0,
      verifiedDocuments: 5 // capped at 10
    });
    expect(rich.score).toBe(100);
    expect(rich.components).toEqual({
      base: 10,
      training: 30,
      trade_history: 25,
      repayment_history: 25,
      documentation: 10,
      penalties: 0
    });
  });

  it('penalises defaults and late repayments, floored at zero', () => {
    const score = computeCreditScore({ ...zero, defaultedLoans: 2, lateRepayments: 4 });
    expect(score.components.penalties).toBe(2 * 20 + 4 * 3);
    expect(score.score).toBe(0);
  });

  it('rejects non-integer signals', () => {
    expect(() => computeCreditScore({ ...zero, completedOrders: 1.5 })).toThrow(/non-negative integer/);
  });
});
