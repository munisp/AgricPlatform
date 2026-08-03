import { describe, expect, it } from 'vitest';
import {
  GEO_BOUNDARY_KINDS,
  GEO_INDEXED_ENTITIES,
  H3_RESOLUTIONS,
  pointInGeojsonGeometry,
  pointInRing
} from '../src/geo.js';

/** Unit square (0,0)–(10,10) as a closed GeoJSON ring, [lng, lat] order. */
const SQUARE_RING = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0]
];

const SQUARE = { type: 'Polygon', coordinates: [SQUARE_RING] };

/** 0–10 square with a 2–4 hole in the corner. */
const SQUARE_WITH_HOLE = {
  type: 'Polygon',
  coordinates: [
    SQUARE_RING,
    [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2]
    ]
  ]
};

const TWO_SQUARES = {
  type: 'MultiPolygon',
  coordinates: [
    [SQUARE_RING],
    [
      [
        [20, 20],
        [30, 20],
        [30, 30],
        [20, 30],
        [20, 20]
      ]
    ]
  ]
};

describe('geospatial pack primitives', () => {
  it('keeps the resolution and entity fixtures stable', () => {
    expect(H3_RESOLUTIONS).toEqual([5, 7, 9]);
    expect(GEO_INDEXED_ENTITIES).toEqual(['farm_plot', 'profile']);
    expect(GEO_BOUNDARY_KINDS).toEqual(['state', 'lga', 'ward', 'custom']);
  });

  it('classifies points inside and outside a simple polygon', () => {
    expect(pointInGeojsonGeometry([5, 5], SQUARE)).toBe(true);
    expect(pointInGeojsonGeometry([0.5, 9.5], SQUARE)).toBe(true);
    expect(pointInGeojsonGeometry([15, 5], SQUARE)).toBe(false);
    expect(pointInGeojsonGeometry([5, -1], SQUARE)).toBe(false);
    expect(pointInGeojsonGeometry([-1, -1], SQUARE)).toBe(false);
  });

  it('counts points exactly on an edge or vertex as inside (documented)', () => {
    expect(pointInGeojsonGeometry([0, 5], SQUARE)).toBe(true); // on west edge
    expect(pointInGeojsonGeometry([5, 0], SQUARE)).toBe(true); // on south edge
    expect(pointInGeojsonGeometry([0, 0], SQUARE)).toBe(true); // on a vertex
  });

  it('excludes points inside a polygon hole (hole edge included)', () => {
    expect(pointInGeojsonGeometry([3, 3], SQUARE_WITH_HOLE)).toBe(false); // in hole
    expect(pointInGeojsonGeometry([5, 5], SQUARE_WITH_HOLE)).toBe(true);
    // Hole membership wins over outer-ring edge semantics: a point on the
    // hole edge is inside the hole ring, therefore outside the polygon.
    expect(pointInGeojsonGeometry([2, 3], SQUARE_WITH_HOLE)).toBe(false);
  });

  it('supports MultiPolygon geometries', () => {
    expect(pointInGeojsonGeometry([25, 25], TWO_SQUARES)).toBe(true);
    expect(pointInGeojsonGeometry([5, 5], TWO_SQUARES)).toBe(true);
    expect(pointInGeojsonGeometry([15, 15], TWO_SQUARES)).toBe(false);
  });

  it('fails closed on malformed geometry or coordinates', () => {
    expect(pointInGeojsonGeometry([5, 5], null)).toBe(false);
    expect(pointInGeojsonGeometry([5, 5], { type: 'Point', coordinates: [5, 5] })).toBe(false);
    expect(pointInGeojsonGeometry([5, 5], { type: 'Polygon' })).toBe(false);
    expect(pointInGeojsonGeometry([5, 5], { type: 'Polygon', coordinates: 'nope' })).toBe(false);
    expect(pointInGeojsonGeometry([Number.NaN, 5], SQUARE)).toBe(false);
    expect(
      pointInGeojsonGeometry([5, 5], {
        type: 'Polygon',
        coordinates: [[[0, 0], ['x', 1], [0, 0]]]
      })
    ).toBe(false);
  });

  it('pointInRing rejects degenerate rings', () => {
    expect(pointInRing([1, 1], [[0, 0], [1, 1]])).toBe(false);
    expect(pointInRing([1, 1], [])).toBe(false);
  });
});
