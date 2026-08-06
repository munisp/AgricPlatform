import { describe, expect, it } from 'vitest';
import {
  aggregateHeatDays,
  aggregateRainfallMm,
  computeEvidenceFingerprint,
  evaluateTrigger,
  floodBandForRank,
  floodSeverityRank,
  HEAT_DAY_THRESHOLD_C,
  payoutBandFor,
  payoutKoboFor
} from './trigger-engine.js';

const RAIN_TRIGGER = { operator: 'lte' as const, threshold: 40 };
const FLOOD_TRIGGER = { operator: 'gte' as const, threshold: 3 };

describe('evaluateTrigger — boundary math', () => {
  it('fires lte strictly below the threshold with the proportional breach ratio', () => {
    const result = evaluateTrigger(RAIN_TRIGGER, 30);
    expect(result.triggered).toBe(true);
    expect(result.breachRatio).toBeCloseTo(0.25, 10);
  });

  it('fires lte EXACTLY at the threshold with breach ratio 0 (at-threshold is a breach)', () => {
    const result = evaluateTrigger(RAIN_TRIGGER, 40);
    expect(result.triggered).toBe(true);
    expect(result.breachRatio).toBe(0);
  });

  it('does not fire lte above the threshold', () => {
    const result = evaluateTrigger(RAIN_TRIGGER, 40.1);
    expect(result.triggered).toBe(false);
    expect(result.breachRatio).toBe(0);
  });

  it('fires gte strictly above the threshold with the proportional breach ratio', () => {
    const result = evaluateTrigger(FLOOD_TRIGGER, 4);
    expect(result.triggered).toBe(true);
    expect(result.breachRatio).toBeCloseTo(1 / 3, 10);
  });

  it('fires gte EXACTLY at the threshold with breach ratio 0', () => {
    const result = evaluateTrigger(FLOOD_TRIGGER, 3);
    expect(result.triggered).toBe(true);
    expect(result.breachRatio).toBe(0);
  });

  it('does not fire gte below the threshold', () => {
    const result = evaluateTrigger(FLOOD_TRIGGER, 2.999);
    expect(result.triggered).toBe(false);
  });

  it('handles a zero threshold without dividing by zero', () => {
    expect(evaluateTrigger({ operator: 'lte', threshold: 0 }, 0)).toEqual({
      triggered: true,
      breachRatio: 0
    });
    expect(evaluateTrigger({ operator: 'gte', threshold: 0 }, 5)).toEqual({
      triggered: true,
      breachRatio: 0
    });
  });

  it('caps nothing — total rainfall failure reaches ratio 1', () => {
    const result = evaluateTrigger(RAIN_TRIGGER, 0);
    expect(result.triggered).toBe(true);
    expect(result.breachRatio).toBe(1);
  });
});

describe('payoutBandFor — graduated bands', () => {
  const table = [
    { minRatio: 0, payoutPercent: 25 },
    { minRatio: 0.5, payoutPercent: 100 },
    { minRatio: 0.25, payoutPercent: 60 }
  ];

  it('pays the lowest band exactly at the threshold (ratio 0)', () => {
    expect(payoutBandFor(table, 0)?.payoutPercent).toBe(25);
  });

  it('pays the middle band exactly at its boundary (ratio 0.25)', () => {
    expect(payoutBandFor(table, 0.25)?.payoutPercent).toBe(60);
  });

  it('pays the top band exactly at its boundary (ratio 0.5)', () => {
    expect(payoutBandFor(table, 0.5)?.payoutPercent).toBe(100);
  });

  it('pays the middle band between boundaries', () => {
    expect(payoutBandFor(table, 0.4999)?.payoutPercent).toBe(60);
  });

  it('returns undefined when no band matches (table without a zero band)', () => {
    expect(payoutBandFor([{ minRatio: 0.1, payoutPercent: 50 }], 0)).toBeUndefined();
  });

  it('matches bands regardless of table ordering', () => {
    const reversed = [...table].reverse();
    expect(payoutBandFor(reversed, 0.75)?.payoutPercent).toBe(100);
  });
});

describe('payoutKoboFor', () => {
  it('computes the graduated payout in integer kobo', () => {
    expect(payoutKoboFor(1_000_000, 25)).toBe(250_000);
    expect(payoutKoboFor(1_000_000, 60)).toBe(600_000);
    expect(payoutKoboFor(1_000_000, 100)).toBe(1_000_000);
  });

  it('rounds to the nearest kobo', () => {
    expect(payoutKoboFor(100_001, 25)).toBe(25_000); // 25_000.25 → 25_000
    expect(payoutKoboFor(100_002, 25)).toBe(25_001); // 25_000.50 → 25_001
  });
});

describe('weather aggregates', () => {
  it('sums daily rainfall to one decimal', () => {
    expect(aggregateRainfallMm([1.1, 2.2, 3.3])).toBeCloseTo(6.6, 10);
    expect(aggregateRainfallMm([])).toBe(0);
  });

  it('counts heat days at or above the threshold (exactly 38 °C counts)', () => {
    expect(
      aggregateHeatDays([37.9, HEAT_DAY_THRESHOLD_C, 38.5, 30, HEAT_DAY_THRESHOLD_C - 0.1])
    ).toBe(2);
  });
});

describe('flood rank mapping', () => {
  it('maps known severities to ranks and back', () => {
    expect(floodSeverityRank('none')).toBe(0);
    expect(floodSeverityRank('moderate')).toBe(2);
    expect(floodSeverityRank('severe')).toBe(4);
    expect(floodBandForRank(3)).toBe('high');
    expect(floodBandForRank(0)).toBe('none');
  });

  it('fails safe: unknown severity maps to rank 0 (none)', () => {
    expect(floodSeverityRank('unknown-label')).toBe(0);
  });
});

describe('computeEvidenceFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeEvidenceFingerprint(['pol-1', '2026-wet', 'cell', 'rainfall_mm', 32.5]);
    const b = computeEvidenceFingerprint(['pol-1', '2026-wet', 'cell', 'rainfall_mm', 32.5]);
    expect(a).toBe(b);
  });

  it('changes when any input changes', () => {
    const base = computeEvidenceFingerprint(['pol-1', 'cell', 30]);
    expect(computeEvidenceFingerprint(['pol-1', 'cell', 31])).not.toBe(base);
    expect(computeEvidenceFingerprint(['pol-2', 'cell', 30])).not.toBe(base);
  });
});
