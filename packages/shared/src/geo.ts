import type { FarmPlot } from './farms.js';

/**
 * Geospatial pack domain primitives — Wave GEO (migration 026, geo schema).
 * Best-of-both merge from farmer-data-collection (H3 analysis, map views)
 * rewritten onto AgricPlatform's hard NO-PostGIS constraint: CI runs
 * postgres:16-alpine, so geo data stays lat/long columns + JSONB and all
 * spatial indexing is computed in the application layer via h3-js.
 * docs/geospatial.md documents the optional PostGIS ops upgrade path.
 */

/** Resolutions precomputed for every indexed entity (migration 026). */
export const H3_RESOLUTIONS = [5, 7, 9] as const;
export type H3Resolution = (typeof H3_RESOLUTIONS)[number];

/** Entities covered by the H3 index (POST /geo/reindex scope). */
export const GEO_INDEXED_ENTITIES = ['farm_plot', 'profile'] as const;
export type GeoIndexedEntity = (typeof GEO_INDEXED_ENTITIES)[number];

export const GEO_BOUNDARY_KINDS = ['state', 'lga', 'ward', 'custom'] as const;
export type GeoBoundaryKind = (typeof GEO_BOUNDARY_KINDS)[number];

/** One row of geo.h3_index: cells at res 5/7/9 for a geo-located entity. */
export interface H3IndexEntry {
  entity: string;
  entityId: string;
  h3Res5: string;
  h3Res7: string;
  h3Res9: string;
  lat: number;
  long: number;
  updatedAt: string;
}

/** A named boundary (state/LGA/ward/custom) behind GET /geo/boundaries. */
export interface GeoBoundary {
  id: string;
  kind: GeoBoundaryKind;
  name: string;
  /** Parent in the state → lga → ward hierarchy; absent at the top level. */
  parentId?: string;
  /** Raw GeoJSON Polygon/MultiPolygon geometry (JSONB — no PostGIS). */
  boundaryGeojson: unknown;
  createdAt: string;
}

/** Farms inside the k-ring around a cell — GET /geo/farms/near. */
export interface GeoFarmsNearResult {
  centerCell: string;
  resolution: H3Resolution;
  ring: number;
  /** Owner-scoped: non-managers only ever receive their own plots. */
  plots: FarmPlot[];
}

/** One H3 cell + indexed-farm count — GET /geo/farms/clusters. */
export interface GeoClusterCell {
  cell: string;
  count: number;
}

export interface GeoClustersResult {
  entity: GeoIndexedEntity;
  resolution: H3Resolution;
  cells: GeoClusterCell[];
  /** Total indexed entities across all cells. */
  total: number;
}

/** Per-entity outcome of POST /geo/reindex (idempotent, admin-only). */
export interface GeoReindexEntityReport {
  entity: GeoIndexedEntity;
  /** Entities read from the source repository. */
  scanned: number;
  /** Entities (re)written into geo.h3_index. */
  indexed: number;
  /** Entities without usable coordinates (profiles only). */
  skipped: number;
}

export interface GeoReindexResult {
  reports: GeoReindexEntityReport[];
}

/** GeoJSON cell boundary for map rendering — GET /geo/cells/:h3. */
export interface GeoCellBoundary {
  cell: string;
  resolution: number;
  /** Closed GeoJSON Polygon ring, [longitude, latitude] positions. */
  boundary: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

/** Point-in-boundary outcome — POST /geo/contains. */
export interface GeoContainsResult {
  contains: boolean;
}

/* -------------------------------------------------------------------------
 * Point-in-boundary helper (ray casting over GeoJSON polygons — no
 * geometry library, no PostGIS). Used by POST /geo/contains today and by
 * livestock movement-permit checks later. Semantics are deterministic:
 * a point exactly ON an edge or vertex counts as INSIDE.
 * ---------------------------------------------------------------------- */

type Position = readonly [number, number]; // [longitude, latitude]

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when q lies exactly on segment a→b (collinear + within bbox). */
function pointOnSegment(q: Position, a: Position, b: Position): boolean {
  const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  const tolerance = 1e-9 * Math.max(1, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  if (Math.abs(cross) > tolerance) {
    return false;
  }
  return (
    q[0] >= Math.min(a[0], b[0]) - 1e-12 &&
    q[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    q[1] >= Math.min(a[1], b[1]) - 1e-12 &&
    q[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}

/** Ray casting over one linear ring; edge/vertex hits count as inside. */
export function pointInRing(point: Position, ring: readonly unknown[]): boolean {
  if (ring.length < 3) {
    return false;
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j] as readonly unknown[];
    const b = ring[i] as readonly unknown[];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    const pa: Position = [a[0], a[1]] as Position;
    const pb: Position = [b[0], b[1]] as Position;
    if (![...pa, ...pb].every(isFiniteNumber)) {
      return false;
    }
    if (pointOnSegment(point, pa, pb)) {
      return true; // documented: on the boundary counts as inside
    }
    const intersects =
      pa[1] > point[1] !== pb[1] > point[1] &&
      point[0] < ((pb[0] - pa[0]) * (point[1] - pa[1])) / (pb[1] - pa[1]) + pa[0];
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function ringArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** One polygon: outer ring minus holes (GeoJSON ring order). */
function pointInPolygonCoordinates(point: Position, polygon: readonly unknown[]): boolean {
  const rings = polygon.map(ringArray);
  const outer = rings[0];
  if (!outer || outer.length < 3) {
    return false;
  }
  if (!pointInRing(point, outer)) {
    return false;
  }
  // Inside a hole = outside the polygon; the hole's own edge counts as
  // inside the hole ring, hence also outside the polygon (deterministic).
  return !rings.slice(1).some((hole) => hole.length >= 3 && pointInRing(point, hole));
}

/**
 * Ray-casting containment for a GeoJSON Polygon/MultiPolygon GEOMETRY
 * object ({ type, coordinates }). `point` is [longitude, latitude] —
 * GeoJSON order. Returns false for malformed input (fail-closed).
 */
export function pointInGeojsonGeometry(
  point: Position,
  geometry: unknown
): boolean {
  if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
    return false;
  }
  if (typeof geometry !== 'object' || geometry === null || Array.isArray(geometry)) {
    return false;
  }
  const candidate = geometry as { type?: unknown; coordinates?: unknown };
  if (candidate.type === 'Polygon') {
    return pointInPolygonCoordinates(point, ringArray(candidate.coordinates));
  }
  if (candidate.type === 'MultiPolygon') {
    return ringArray(candidate.coordinates).some((polygon) =>
      pointInPolygonCoordinates(point, ringArray(polygon))
    );
  }
  return false;
}
