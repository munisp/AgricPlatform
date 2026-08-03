import { describe, expect, it } from 'vitest';
import {
  FARM_EXPENSE_CATEGORIES,
  HARVEST_UNITS,
  isValidBoundaryGeojson,
  PLANTING_STATUSES,
  SOIL_TYPES
} from '../src/farms.js';

describe('farms domain primitives', () => {
  it('accepts Polygon and MultiPolygon boundary geometries', () => {
    expect(
      isValidBoundaryGeojson({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] })
    ).toBe(true);
    expect(
      isValidBoundaryGeojson({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [0, 0]]]] })
    ).toBe(true);
  });

  it('rejects non-polygon, non-object and coordinate-less values', () => {
    expect(isValidBoundaryGeojson({ type: 'Point', coordinates: [1, 2] })).toBe(false);
    expect(isValidBoundaryGeojson({ type: 'Polygon' })).toBe(false);
    expect(isValidBoundaryGeojson('Polygon')).toBe(false);
    expect(isValidBoundaryGeojson(null)).toBe(false);
    expect(isValidBoundaryGeojson([1, 2, 3])).toBe(false);
    expect(isValidBoundaryGeojson(undefined)).toBe(false);
  });

  it('keeps the planting lifecycle and fixture lists stable', () => {
    expect(PLANTING_STATUSES).toEqual(['growing', 'harvested', 'failed']);
    expect(HARVEST_UNITS).toContain('kg');
    expect(FARM_EXPENSE_CATEGORIES).toContain('fertilizer');
    expect(SOIL_TYPES.length).toBeGreaterThan(0);
  });
});
