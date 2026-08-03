import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { H3Service, MAX_GEO_RING } from './h3.service.js';

/**
 * Ground-truth H3 cells computed with h3-js 4.5.0 (the locked dependency):
 *   latLngToCell(11.0855, 7.7199, 5|7|9) — Zaria, Kaduna
 *   latLngToCell(12.0022, 8.5920, 5|7|9)  — Kano
 */
const ZARIA = { lat: 11.0855, long: 7.7199 } as const;
const ZARIA_CELLS = {
  5: '85581b97fffffff',
  7: '87581b966ffffff',
  9: '89581b96683ffff'
} as const;
const KANO_CELLS = {
  5: '85580a47fffffff',
  7: '87580a4edffffff',
  9: '89580a4ed37ffff'
} as const;

describe('H3Service', () => {
  const h3 = new H3Service();

  it('maps known coordinates to known cells at every indexed resolution', () => {
    expect(h3.indexPoint(ZARIA.lat, ZARIA.long)).toEqual({
      h3Res5: ZARIA_CELLS[5],
      h3Res7: ZARIA_CELLS[7],
      h3Res9: ZARIA_CELLS[9]
    });
    expect(h3.cellAt(12.0022, 8.592, 5)).toBe(KANO_CELLS[5]);
    expect(h3.cellAt(12.0022, 8.592, 7)).toBe(KANO_CELLS[7]);
    expect(h3.cellAt(12.0022, 8.592, 9)).toBe(KANO_CELLS[9]);
  });

  it('returns k-ring disks of the exact hexagonal sizes 1/7/19', () => {
    const center = ZARIA_CELLS[7];
    expect(h3.disk(center, 0)).toEqual([center]);
    expect(h3.disk(center, 1)).toHaveLength(7);
    expect(h3.disk(center, 2)).toHaveLength(19);
    // The disk always contains its centre.
    expect(h3.disk(center, 1)).toContain(center);
  });

  it('caps the ring fail-closed', () => {
    expect(() => h3.disk(ZARIA_CELLS[7], MAX_GEO_RING + 1)).toThrow(BadRequestException);
    expect(() => h3.disk(ZARIA_CELLS[7], -1)).toThrow(BadRequestException);
    expect(() => h3.disk(ZARIA_CELLS[7], 1.5)).toThrow(BadRequestException);
  });

  it('rejects out-of-range coordinates and unsupported resolutions', () => {
    expect(() => h3.cellAt(91, 0, 7)).toThrow(BadRequestException);
    expect(() => h3.cellAt(0, 181, 7)).toThrow(BadRequestException);
    expect(() => h3.cellAt(Number.NaN, 0, 7)).toThrow(BadRequestException);
    expect(() => h3.assertResolution(6)).toThrow(BadRequestException);
    expect(h3.assertResolution(7)).toBe(7);
  });

  it('produces a closed GeoJSON boundary ring in [long, lat] order', () => {
    const boundary = h3.boundaryGeojson(ZARIA_CELLS[7]);
    expect(boundary.type).toBe('Polygon');
    const ring = boundary.coordinates[0];
    expect(ring.length).toBeGreaterThanOrEqual(7); // hexagon + closing point
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Longitudes around 7.72, latitudes around 11.08 (GeoJSON order).
    expect(Math.abs(ring[0][0] - 7.72)).toBeLessThan(0.1);
    expect(Math.abs(ring[0][1] - 11.08)).toBeLessThan(0.1);
    expect(h3.resolutionOf(ZARIA_CELLS[7])).toBe(7);
  });

  it('rejects invalid cell indexes', () => {
    expect(() => h3.disk('not-a-cell', 1)).toThrow(BadRequestException);
    expect(() => h3.boundaryGeojson('not-a-cell')).toThrow(BadRequestException);
    expect(() => h3.center('not-a-cell')).toThrow(BadRequestException);
  });
});
