import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  CARBON_COEFFICIENTS,
  CO2E_COEFFICIENT_VERSION,
  coefficientFor,
  computeCo2eEstimateMilliTonnes
} from './carbon-coefficients.js';

describe('carbon ESTIMATE coefficient table', () => {
  it('is versioned and covers every practice type', () => {
    expect(CO2E_COEFFICIENT_VERSION).toMatch(/^v\d+\./);
    const practices = CARBON_COEFFICIENTS.map((entry) => entry.practiceType);
    expect(practices).toEqual(
      expect.arrayContaining(['agroforestry', 'fmnr', 'woodlot', 'conservation_agriculture'])
    );
  });

  it('cites a public source for every coefficient (honesty doctrine)', () => {
    for (const entry of CARBON_COEFFICIENTS) {
      expect(entry.source.length).toBeGreaterThan(10);
      expect(entry.co2eMilliTonnesPerHaYear).toBeGreaterThan(0);
    }
  });

  it('looks up coefficients by practice type', () => {
    expect(coefficientFor('agroforestry').co2eMilliTonnesPerHaYear).toBe(4_000);
    expect(coefficientFor('woodlot').practiceType).toBe('woodlot');
  });

  it('rejects unknown practice types fail-closed', () => {
    expect(() => coefficientFor('palm_oil' as never)).toThrow(BadRequestException);
  });
});

describe('computeCo2eEstimateMilliTonnes (deterministic ESTIMATE math)', () => {
  it('computes hectares * rate * survival * seasons with one integer floor', () => {
    // 2.5 ha agroforestry (4 t/ha/yr), 80% survival, 2 seasons → 16 t
    expect(
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 250,
        practiceType: 'agroforestry',
        survivalRatePct: 80,
        seasonCount: 2
      })
    ).toBe(16_000);
  });

  it('scales linearly with survival rate and season count', () => {
    const base = computeCo2eEstimateMilliTonnes({
      hectaresCenti: 100,
      practiceType: 'fmnr',
      survivalRatePct: 100,
      seasonCount: 1
    });
    expect(base).toBe(3_000);
    expect(
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 100,
        practiceType: 'fmnr',
        survivalRatePct: 50,
        seasonCount: 1
      })
    ).toBe(1_500);
    expect(
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 100,
        practiceType: 'fmnr',
        survivalRatePct: 100,
        seasonCount: 3
      })
    ).toBe(9_000);
  });

  it('floors once at the end (no intermediate rounding drift)', () => {
    // 0.33 ha conservation agriculture (1 t/ha/yr), 100%, 1 season → 0.33 t
    expect(
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 33,
        practiceType: 'conservation_agriculture',
        survivalRatePct: 100,
        seasonCount: 1
      })
    ).toBe(330);
  });

  it('is byte-stable across recomputation', () => {
    const input = {
      hectaresCenti: 1_234,
      practiceType: 'woodlot' as const,
      survivalRatePct: 77,
      seasonCount: 4
    };
    expect(computeCo2eEstimateMilliTonnes(input)).toBe(computeCo2eEstimateMilliTonnes(input));
  });

  it('rejects invalid inputs fail-closed', () => {
    expect(() =>
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 0,
        practiceType: 'fmnr',
        survivalRatePct: 100,
        seasonCount: 1
      })
    ).toThrow(BadRequestException);
    expect(() =>
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 100,
        practiceType: 'fmnr',
        survivalRatePct: 101,
        seasonCount: 1
      })
    ).toThrow(BadRequestException);
    expect(() =>
      computeCo2eEstimateMilliTonnes({
        hectaresCenti: 100,
        practiceType: 'fmnr',
        survivalRatePct: 100,
        seasonCount: 0
      })
    ).toThrow(BadRequestException);
  });
});
