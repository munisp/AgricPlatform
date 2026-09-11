import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { generateCreditSchedule } from './credit.service.js';
import {
  generateSeasonalSchedule,
  seasonalScheduleTotalKobo,
  type SeasonalScheduleInput
} from './seasonal-schedule.js';

/**
 * SeasonSync pure-generator known-answer vectors. Every expected kobo
 * amount below is hand-computed in the test commentary — the generator is
 * deterministic (no clock, no randomness), so these vectors pin the byte
 * shape of the schedule.
 */

const BASE: SeasonalScheduleInput = {
  principalKobo: 1_000_000, // ₦10,000
  interestBpsAnnual: 1200, // 12% annual
  termDays: 180,
  startIso: '2026-03-01T00:00:00.000Z',
  plantingDateIso: '2026-04-01T00:00:00.000Z',
  harvestWindowStartIso: '2026-07-15T00:00:00.000Z',
  harvestWindowEndIso: '2026-08-14T00:00:00.000Z' // 30-day window
};

// interest = floor(1_000_000 * 1200 * 180 / (10_000 * 365)) = 59_178
// total    = 1_059_178
const EXPECTED_TOTAL = 1_059_178;

describe('generateSeasonalSchedule — known-answer vectors', () => {
  it('default two balloon installments: weights 1:2, largest-remainder rounding', () => {
    // weights 1,2 (sum 3): floors = 353_059 (rem 1) and 706_118 (rem 2);
    // residual 1 kobo lands on the largest remainder (installment 2).
    const schedule = generateSeasonalSchedule(BASE);
    expect(schedule).toEqual([
      { sequence: 1, dueAt: '2026-07-15T00:00:00.000Z', amountKobo: 353_059 },
      { sequence: 2, dueAt: '2026-08-14T00:00:00.000Z', amountKobo: 706_119 }
    ]);
    expect(seasonalScheduleTotalKobo(schedule)).toBe(EXPECTED_TOTAL);
  });

  it('single balloon: the whole total falls due at the harvest-window open', () => {
    const schedule = generateSeasonalSchedule({ ...BASE, harvestInstallments: 1 });
    expect(schedule).toEqual([
      { sequence: 1, dueAt: '2026-07-15T00:00:00.000Z', amountKobo: EXPECTED_TOTAL }
    ]);
  });

  it('three balloons: weights 1:2:3 spread evenly across the window', () => {
    // floors over weight sum 6: 176_529 (rem 4), 353_059 (rem 2), 529_589
    // (rem 0); residual 1 kobo lands on installment 1. Due dates at window
    // open / midpoint (day 15) / close.
    const schedule = generateSeasonalSchedule({ ...BASE, harvestInstallments: 3 });
    expect(schedule).toEqual([
      { sequence: 1, dueAt: '2026-07-15T00:00:00.000Z', amountKobo: 176_530 },
      { sequence: 2, dueAt: '2026-07-30T00:00:00.000Z', amountKobo: 353_059 },
      { sequence: 3, dueAt: '2026-08-14T00:00:00.000Z', amountKobo: 529_589 }
    ]);
    expect(seasonalScheduleTotalKobo(schedule)).toBe(EXPECTED_TOTAL);
  });

  it('interest invariant: the seasonal total equals the equal-installment total', () => {
    const equal = generateCreditSchedule({
      loanId: 'cloan-x',
      principalKobo: BASE.principalKobo,
      interestBpsAnnual: BASE.interestBpsAnnual,
      termDays: BASE.termDays,
      startIso: BASE.startIso
    });
    const equalTotal = equal.reduce((sum, entry) => sum + entry.amountKobo, 0);
    expect(seasonalScheduleTotalKobo(generateSeasonalSchedule(BASE))).toBe(equalTotal);
    expect(equalTotal).toBe(EXPECTED_TOTAL);
  });

  it('zero interest: installments repay principal exactly (7 kobo over 2 balloons → 2 + 5)', () => {
    const schedule = generateSeasonalSchedule({
      ...BASE,
      principalKobo: 7,
      interestBpsAnnual: 0
    });
    expect(schedule.map((entry) => entry.amountKobo)).toEqual([2, 5]);
    expect(seasonalScheduleTotalKobo(schedule)).toBe(7);
  });

  it('multi-kobo remainder distributes one kobo per largest fractional part', () => {
    // total 5 over weights 1:2:3 → floors 0,1,2 with fractions 5,4,3 (of 6);
    // residual 2 kobo → installments 1 and 2.
    const schedule = generateSeasonalSchedule({
      ...BASE,
      principalKobo: 5,
      interestBpsAnnual: 0,
      harvestInstallments: 3
    });
    expect(schedule.map((entry) => entry.amountKobo)).toEqual([1, 2, 2]);
  });
});

describe('generateSeasonalSchedule — grace shape', () => {
  it('no installment falls before the harvest window opens (grace = growing season)', () => {
    for (const harvestInstallments of [1, 2, 3] as const) {
      const schedule = generateSeasonalSchedule({ ...BASE, harvestInstallments });
      for (const installment of schedule) {
        expect(Date.parse(installment.dueAt)).toBeGreaterThanOrEqual(
          Date.parse(BASE.harvestWindowStartIso)
        );
        expect(Date.parse(installment.dueAt)).toBeLessThanOrEqual(
          Date.parse(BASE.harvestWindowEndIso)
        );
      }
    }
  });

  it('balloon weighting is increasing: later installments are never smaller', () => {
    const schedule = generateSeasonalSchedule({ ...BASE, harvestInstallments: 3 });
    for (let index = 1; index < schedule.length; index += 1) {
      expect(schedule[index].amountKobo).toBeGreaterThanOrEqual(schedule[index - 1].amountKobo);
    }
  });
});

describe('generateSeasonalSchedule — tenor and calendar bounds (fail-closed)', () => {
  it('rejects an inverted harvest window', () => {
    expect(() =>
      generateSeasonalSchedule({
        ...BASE,
        harvestWindowStartIso: '2026-08-14T00:00:00.000Z',
        harvestWindowEndIso: '2026-07-15T00:00:00.000Z'
      })
    ).toThrowError(/SEASONAL_WINDOW_ORDER/);
  });

  it('rejects a planting date inside/after the harvest window', () => {
    expect(() =>
      generateSeasonalSchedule({ ...BASE, plantingDateIso: '2026-07-15T00:00:00.000Z' })
    ).toThrowError(/SEASONAL_WINDOW_ORDER/);
  });

  it('rejects a harvest window that opens before the schedule start', () => {
    expect(() =>
      generateSeasonalSchedule({ ...BASE, startIso: '2026-08-01T00:00:00.000Z' })
    ).toThrowError(/SEASONAL_WINDOW_BEFORE_START/);
  });

  it('rejects a harvest window ending beyond the loan tenor', () => {
    // start 2026-03-01 + 180 days = 2026-08-28; window end 2026-09-01 exceeds it.
    expect(() =>
      generateSeasonalSchedule({ ...BASE, harvestWindowEndIso: '2026-09-01T00:00:00.000Z' })
    ).toThrowError(/SEASONAL_WINDOW_BEYOND_TENOR/);
  });

  it('rejects balloon counts outside 1–3', () => {
    expect(() => generateSeasonalSchedule({ ...BASE, harvestInstallments: 0 })).toThrowError(
      /SEASONAL_BALLOON_COUNT/
    );
    expect(() => generateSeasonalSchedule({ ...BASE, harvestInstallments: 4 })).toThrowError(
      /SEASONAL_BALLOON_COUNT/
    );
  });

  it('rejects non-integer or non-positive principal', () => {
    expect(() => generateSeasonalSchedule({ ...BASE, principalKobo: 0 })).toThrowError(
      BadRequestException
    );
    expect(() => generateSeasonalSchedule({ ...BASE, principalKobo: 1.5 })).toThrowError(
      /SEASONAL_PRINCIPAL/
    );
  });

  it('rejects unparseable dates', () => {
    expect(() =>
      generateSeasonalSchedule({ ...BASE, harvestWindowStartIso: 'not-a-date' })
    ).toThrowError(/SEASONAL_CALENDAR_INVALID/);
  });
});
