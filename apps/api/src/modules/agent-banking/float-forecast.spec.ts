import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  FLOAT_FORECAST_MODEL_VERSION,
  MAX_FORECAST_HORIZON_DAYS,
  MIN_HISTORY_DAYS,
  addDays,
  daysBetween,
  densifyDailyFlows,
  fitForecast,
  parseIsoDate,
  weekdayOf,
  type DailyNetFlow
} from './float-forecast.js';

/**
 * Known-answer vectors for the deterministic v1 model. Every expected kobo
 * value below was computed with an INDEPENDENT exact-rational reference
 * implementation (Fraction arithmetic, no float64) of the documented
 * algorithm and cross-checked to sit far from any rounding boundary, so
 * these assertions pin the model bit-for-bit.
 */

function series(start: string, days: number, flow: (index: number) => number): DailyNetFlow[] {
  const rows: DailyNetFlow[] = [];
  for (let index = 0; index < days; index += 1) {
    rows.push({ date: addDays(start, index), netFlowKobo: flow(index) });
  }
  return rows;
}

describe('float-forecast date helpers', () => {
  it('parses strict ISO days and rejects impossible dates', () => {
    expect(new Date(parseIsoDate('2026-01-05')).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(() => parseIsoDate('2026-02-31')).toThrow('not a real calendar day');
    expect(() => parseIsoDate('2026-1-5')).toThrow('expected YYYY-MM-DD');
    expect(() => parseIsoDate('2026/01/05')).toThrow('expected YYYY-MM-DD');
  });

  it('addDays/daysBetween/weekdayOf agree with the calendar', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-01-05', '2026-01-18')).toBe(13);
    expect(weekdayOf('2026-01-04')).toBe(0); // Sunday
    expect(weekdayOf('2026-01-05')).toBe(1); // Monday
  });
});

describe('densifyDailyFlows', () => {
  it('zero-fills gaps between the first and last day', () => {
    const dense = densifyDailyFlows([
      { date: '2026-01-05', netFlowKobo: 10_000 },
      { date: '2026-01-08', netFlowKobo: -4_000 }
    ]);
    expect(dense).toEqual([
      { date: '2026-01-05', netFlowKobo: 10_000 },
      { date: '2026-01-06', netFlowKobo: 0 },
      { date: '2026-01-07', netFlowKobo: 0 },
      { date: '2026-01-08', netFlowKobo: -4_000 }
    ]);
  });

  it('fails closed on duplicates, disorder and malformed rows', () => {
    const dup = [
      { date: '2026-01-05', netFlowKobo: 1 },
      { date: '2026-01-05', netFlowKobo: 2 }
    ];
    expect(() => densifyDailyFlows(dup)).toThrow('ascending with unique dates');
    const reversed = [
      { date: '2026-01-08', netFlowKobo: 1 },
      { date: '2026-01-05', netFlowKobo: 2 }
    ];
    expect(() => densifyDailyFlows(reversed)).toThrow('ascending with unique dates');
    expect(() => densifyDailyFlows([{ date: 'not-a-day', netFlowKobo: 1 }])).toThrow('Invalid ISO date');
    expect(() => densifyDailyFlows([{ date: '2026-01-05', netFlowKobo: 1.5 }])).toThrow('safe integer');
  });
});

describe('fitForecast — known-answer vectors', () => {
  // Vector A: constant drain of N500/day, trained on 14 days (Mon 2026-01-05
  // .. Sun 2026-01-18). Slope 0, seasonal 0: every prediction is exactly
  // -50_000 kobo and the float walks down in exact N500 steps.
  const vectorA = series('2026-01-05', 14, () => -50_000);

  it('Vector A: constant drain predicts exact steps and depletion day 12', () => {
    const result = fitForecast({
      history: vectorA,
      asOfDate: '2026-01-18',
      horizonDays: 14,
      currentFloatKobo: 700_000,
      depletionThresholdKobo: 100_000,
      excessThresholdKobo: 3_000_000
    });
    expect(result.modelVersion).toBe(FLOAT_FORECAST_MODEL_VERSION);
    expect(result.basis).toBe('seasonal_trend');
    expect(result.historyDays).toBe(14);
    expect(result.trendKoboPerDay).toBe(0);
    expect(result.predictions).toHaveLength(14);
    for (const prediction of result.predictions) {
      expect(prediction.predictedNetFlowKobo).toBe(-50_000);
      expect(prediction.predictedEodFloatKobo).toBe(700_000 - 50_000 * prediction.dayOffset);
      expect(prediction.targetDate).toBe(addDays('2026-01-18', prediction.dayOffset));
    }
    // Day 12 lands exactly on the threshold (<=), day 11 is still above.
    expect(result.predictions[11]).toMatchObject({ targetDate: '2026-01-30', predictedEodFloatKobo: 100_000 });
    expect(result.depletionDate).toBe('2026-01-30');
    expect(result.excessDate).toBeUndefined();
  });

  // Vector B: weekly seasonal pattern (Mon..Sun 1200/900/600/300/0/-900/-1500
  // naira) repeated for 3 weeks. The fitted trend and seasonal indices make
  // each prediction exact; values pinned by the exact-rational reference.
  const weekPattern = [120_000, 90_000, 60_000, 30_000, 0, -90_000, -150_000];
  const vectorB = series('2026-01-05', 21, (index) => weekPattern[index % 7]);
  const vectorBExpected: [number, string, number, number][] = [
    [1, '2026-01-26', 52_909, 1_052_909],
    [2, '2026-01-27', 22_909, 1_075_818],
    [3, '2026-01-28', -7_091, 1_068_727],
    [4, '2026-01-29', -37_091, 1_031_636],
    [5, '2026-01-30', -67_091, 964_545],
    [6, '2026-01-31', -157_091, 807_454],
    [7, '2026-02-01', -217_091, 590_363],
    [8, '2026-02-02', 19_364, 609_727],
    [9, '2026-02-03', -10_636, 599_091],
    [10, '2026-02-04', -40_636, 558_455],
    [11, '2026-02-05', -70_636, 487_819],
    [12, '2026-02-06', -100_636, 387_183],
    [13, '2026-02-07', -190_636, 196_547],
    [14, '2026-02-08', -250_636, -54_089]
  ];

  it('Vector B: weekday seasonal + trend matches the reference implementation to the kobo', () => {
    const result = fitForecast({
      history: vectorB,
      asOfDate: '2026-01-25',
      horizonDays: 14,
      currentFloatKobo: 1_000_000,
      depletionThresholdKobo: 50_000,
      excessThresholdKobo: 5_000_000
    });
    expect(result.trendKoboPerDay).toBe(-4_792);
    expect(
      result.predictions.map((row) => [
        row.dayOffset,
        row.targetDate,
        row.predictedNetFlowKobo,
        row.predictedEodFloatKobo
      ])
    ).toEqual(vectorBExpected);
    expect(result.depletionDate).toBe('2026-02-08');
    expect(result.excessDate).toBeUndefined();
  });

  // Vector C: steady inflow of N2,000/day — the float crosses the excess
  // threshold exactly on day 5 (2_000_000 >= 2_000_000) and never depletes.
  const vectorC = series('2026-01-05', 14, () => 200_000);

  it('Vector C: steady inflow flags excess on day 5 and no depletion', () => {
    const result = fitForecast({
      history: vectorC,
      asOfDate: '2026-01-18',
      horizonDays: 14,
      currentFloatKobo: 1_000_000,
      depletionThresholdKobo: 100_000,
      excessThresholdKobo: 2_000_000
    });
    expect(result.predictions[4]).toMatchObject({
      targetDate: '2026-01-23',
      predictedEodFloatKobo: 2_000_000
    });
    expect(result.excessDate).toBe('2026-01-23');
    expect(result.depletionDate).toBeUndefined();
  });

  it('is deterministic: identical inputs give byte-identical outputs', () => {
    const input = {
      history: vectorB,
      asOfDate: '2026-01-25',
      horizonDays: 14,
      currentFloatKobo: 1_000_000,
      depletionThresholdKobo: 50_000
    };
    expect(fitForecast(input)).toEqual(fitForecast(input));
  });
});

describe('fitForecast — fail-closed guards', () => {
  it('marks fewer than MIN_HISTORY_DAYS days as insufficient_history with no predictions', () => {
    const result = fitForecast({
      history: series('2026-01-05', MIN_HISTORY_DAYS - 1, () => -50_000),
      asOfDate: '2026-01-17',
      horizonDays: 14,
      currentFloatKobo: 700_000,
      depletionThresholdKobo: 100_000
    });
    expect(result.basis).toBe('insufficient_history');
    expect(result.historyDays).toBe(MIN_HISTORY_DAYS - 1);
    expect(result.predictions).toEqual([]);
    expect(result.depletionDate).toBeUndefined();
    expect(result.excessDate).toBeUndefined();
    expect(result.trendKoboPerDay).toBeNull();
  });

  it('accepts exactly MIN_HISTORY_DAYS days', () => {
    const result = fitForecast({
      history: series('2026-01-05', MIN_HISTORY_DAYS, () => -50_000),
      asOfDate: '2026-01-18',
      horizonDays: 7,
      currentFloatKobo: 700_000,
      depletionThresholdKobo: 100_000
    });
    expect(result.basis).toBe('seasonal_trend');
  });

  it('rejects future-dated history and bad horizons', () => {
    const history = series('2026-01-05', 14, () => -1_000);
    expect(() =>
      fitForecast({
        history,
        asOfDate: '2026-01-10',
        horizonDays: 7,
        currentFloatKobo: 0,
        depletionThresholdKobo: 0
      })
    ).toThrow('after asOfDate');
    expect(() =>
      fitForecast({
        history,
        asOfDate: '2026-01-18',
        horizonDays: 0,
        currentFloatKobo: 0,
        depletionThresholdKobo: 0
      })
    ).toThrow('positive integer');
    expect(() =>
      fitForecast({
        history,
        asOfDate: '2026-01-18',
        horizonDays: MAX_FORECAST_HORIZON_DAYS + 1,
        currentFloatKobo: 0,
        depletionThresholdKobo: 0
      })
    ).toThrow(`<= ${MAX_FORECAST_HORIZON_DAYS}`);
    expect(DEFAULT_FORECAST_HORIZON_DAYS).toBe(14);
  });
});
