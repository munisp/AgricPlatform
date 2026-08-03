import { describe, expect, it } from 'vitest';
import {
  computeGeoCreditFactor,
  computeInputFingerprint,
  estimateBoundaryAreaHectares,
  floodBandFromSeverity,
  freshnessPoints,
  GEO_CREDIT_FACTOR_MAX,
  GEO_CREDIT_WEIGHTS,
  type GeoCreditFactorInput
} from './geo-credit-factor.js';

const NOW = '2026-03-01T00:00:00.000Z';

function input(overrides: Partial<GeoCreditFactorInput> = {}): GeoCreditFactorInput {
  return {
    plotVerified: true,
    areaHectares: 2,
    floodBand: 'low',
    cropHealthScore: 50,
    plotUpdatedAt: '2026-02-19T00:00:00.000Z', // 10 days before NOW
    ...overrides
  };
}

describe('computeGeoCreditFactor — known-answer vectors', () => {
  it('reference vector: verified plot, 2 ha, low flood, health 50, 10-day-old record', () => {
    const result = computeGeoCreditFactor(input(), NOW);
    expect(result.breakdown).toEqual({
      plotVerification: 25,
      areaPlausibility: 15,
      floodRisk: 16,
      cropHealth: 15,
      dataFreshness: 10
    });
    expect(result.score).toBe(81);
  });

  it('unverified plot zeroes every component', () => {
    const result = computeGeoCreditFactor(input({ plotVerified: false }), NOW);
    expect(result.breakdown).toEqual({
      plotVerification: 0,
      areaPlausibility: 0,
      floodRisk: 0,
      cropHealth: 0,
      dataFreshness: 0
    });
    expect(result.score).toBe(0);
  });

  it('perfect vector saturates at the 100 cap', () => {
    const result = computeGeoCreditFactor(
      input({ floodBand: 'none', cropHealthScore: 100, plotUpdatedAt: NOW }),
      NOW
    );
    expect(result.score).toBe(GEO_CREDIT_FACTOR_MAX);
    expect(result.score).toBe(
      GEO_CREDIT_WEIGHTS.plotVerification +
        GEO_CREDIT_WEIGHTS.areaPlausibility +
        GEO_CREDIT_WEIGHTS.floodRisk +
        GEO_CREDIT_WEIGHTS.cropHealth +
        GEO_CREDIT_WEIGHTS.dataFreshness
    );
  });

  it.each([
    [0.01, 15],
    [0.009, 0],
    [100, 15],
    [100.01, 0],
    [null, 0]
  ] as const)('area boundary: %s ha → %i points', (areaHectares, points) => {
    const result = computeGeoCreditFactor(input({ areaHectares }), NOW);
    expect(result.breakdown.areaPlausibility).toBe(points);
  });

  it.each([
    ['none', 20],
    ['low', 16],
    ['moderate', 10],
    ['high', 5],
    ['severe', 0]
  ] as const)('flood band: %s → %i points', (floodBand, points) => {
    const result = computeGeoCreditFactor(input({ floodBand }), NOW);
    expect(result.breakdown.floodRisk).toBe(points);
  });

  it.each([
    [0, 0],
    [50, 15],
    [100, 30],
    [140, 30], // clamped, never exceeds the weight
    [null, 0]
  ] as const)('crop health: %s → %i points', (cropHealthScore, points) => {
    const result = computeGeoCreditFactor(input({ cropHealthScore }), NOW);
    expect(result.breakdown.cropHealth).toBe(points);
  });

  it.each([
    ['2026-03-01T00:00:00.000Z', 10], // 0 days
    ['2026-01-30T00:00:00.000Z', 10], // 30 days (boundary)
    ['2026-01-29T00:00:00.000Z', 7], // 31 days
    ['2025-12-01T00:00:00.000Z', 7], // 90 days (boundary)
    ['2025-11-30T00:00:00.000Z', 4], // 91 days
    ['2025-09-02T00:00:00.000Z', 4], // 180 days (boundary)
    ['2025-09-01T00:00:00.000Z', 2], // 181 days
    ['2025-03-01T00:00:00.000Z', 2], // 365 days (boundary)
    ['2025-02-28T00:00:00.000Z', 0] // 366 days
  ] as const)('freshness: updated %s → %i points', (plotUpdatedAt, points) => {
    const result = computeGeoCreditFactor(input({ plotUpdatedAt }), NOW);
    expect(result.breakdown.dataFreshness).toBe(points);
  });

  it('freshness without a plot timestamp scores 0', () => {
    const result = computeGeoCreditFactor(input({ plotUpdatedAt: null }), NOW);
    expect(result.breakdown.dataFreshness).toBe(0);
  });

  it('is deterministic: identical inputs → identical outputs', () => {
    const first = computeGeoCreditFactor(input(), NOW);
    const second = computeGeoCreditFactor(input(), NOW);
    expect(first).toEqual(second);
  });
});

describe('floodBandFromSeverity', () => {
  it('passes through known severities', () => {
    expect(floodBandFromSeverity('severe')).toBe('severe');
    expect(floodBandFromSeverity('none')).toBe('none');
  });

  it('maps unknown severities to the neutral moderate band', () => {
    expect(floodBandFromSeverity('unknown')).toBe('moderate');
    expect(floodBandFromSeverity('')).toBe('moderate');
  });
});

describe('freshnessPoints', () => {
  it('never rewards future timestamps', () => {
    expect(freshnessPoints(-5)).toBe(10);
  });
});

describe('estimateBoundaryAreaHectares', () => {
  it('estimates a ~0.001° square near the equator at ≈1.2 ha', () => {
    const boundary = {
      type: 'Polygon',
      coordinates: [
        [
          [7.0, 11.0],
          [7.001, 11.0],
          [7.001, 11.001],
          [7.0, 11.001],
          [7.0, 11.0]
        ]
      ]
    };
    const area = estimateBoundaryAreaHectares(boundary);
    expect(area).not.toBeNull();
    expect(area!).toBeGreaterThan(1.1);
    expect(area!).toBeLessThan(1.3);
  });

  it('sums MultiPolygon members', () => {
    const square = (offset: number) => [
      [
        [7.0 + offset, 11.0],
        [7.001 + offset, 11.0],
        [7.001 + offset, 11.001],
        [7.0 + offset, 11.001],
        [7.0 + offset, 11.0]
      ]
    ];
    const single = estimateBoundaryAreaHectares({ type: 'Polygon', coordinates: square(0) });
    const double = estimateBoundaryAreaHectares({
      type: 'MultiPolygon',
      coordinates: [square(0), square(0.01)]
    });
    expect(double!).toBeGreaterThan(single! * 1.9);
  });

  it.each([null, undefined, {}, { type: 'Point', coordinates: [7, 11] }, 'nope'])(
    'returns null for missing/invalid geometry: %j',
    (boundary) => {
      expect(estimateBoundaryAreaHectares(boundary)).toBeNull();
    }
  );
});

describe('computeInputFingerprint', () => {
  it('is stable for identical parts', () => {
    expect(computeInputFingerprint(['app-1', 'plot-1', 2, 'low', 50])).toBe(
      computeInputFingerprint(['app-1', 'plot-1', 2, 'low', 50])
    );
  });

  it('changes when any part changes', () => {
    const base = computeInputFingerprint(['app-1', 'plot-1', 2, 'low', 50]);
    expect(computeInputFingerprint(['app-1', 'plot-1', 2, 'low', 51])).not.toBe(base);
    expect(computeInputFingerprint(['app-1', 'plot-2', 2, 'low', 50])).not.toBe(base);
    expect(computeInputFingerprint(['app-1', 'plot-1', 2, 'low', null])).not.toBe(base);
  });
});
