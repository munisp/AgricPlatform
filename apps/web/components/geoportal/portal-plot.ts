import { cellToBoundary, isValidCell } from 'h3-js';
import { isValidBoundaryGeojson } from '@agric-platform/shared';
import type { FarmPlot } from '@agric-platform/shared';
import type { CarbonPlot } from '@/lib/api/endpoints';

/**
 * GeoPortal plot model + pure GeoJSON/spatial helpers.
 *
 * Component stack and conventions follow GeoLibre (github.com/opengeos/
 * GeoLibre — client-side GIS on MapLibre GL + DuckDB-WASM). GeoLibre is not
 * installable as a UI library for this app (see docs/geospatial.md — its
 * @geolibre/map package vendors a second React copy plus Cesium/geotiff),
 * so the portal re-implements the same stack against the platform API.
 *
 * Everything in this module is pure (no maplibre / no fetch) so the
 * vitest/jsdom suite can exercise it directly.
 */

/** Minimal GeoJSON typings (no @types/geojson dependency in this repo). */
export interface GeoJsonPolygonGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
}

export interface GeoJsonPointGeometry {
  type: 'Point';
  coordinates: [number, number];
}

export type GeoJsonGeometry = GeoJsonPolygonGeometry | GeoJsonPointGeometry;

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties: Record<string, string | number | boolean | undefined>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

/**
 * One renderable plot on the portal map, unified across the two platform
 * plot sources:
 *  - `farm`   — GET /farms/plots (GPS-walked boundaryGeojson, state/lga).
 *  - `carbon` — GET /vsla-carbon/plots (H3 res-9 cell; boundary derived
 *               client-side via h3-js, same as the API does server-side).
 */
export interface PortalPlot {
  id: string;
  source: 'farm' | 'carbon';
  name: string;
  ownerUserId: string;
  /** Canonical state name (matches NIGERIAN_STATES); carbon plots are tagged client-side. */
  state?: string;
  lga?: string;
  /** Carbon practice type (agroforestry, fmnr, …) — the portal's crop/practice filter dimension. */
  practiceType?: string;
  hectares: number;
  centroidLat: number;
  centroidLong: number;
  status?: string;
  h3Res9?: string;
  /**
   * 'polygon' = real geometry (walked boundary or H3 cell);
   * 'centroid' = no boundary on record — rendered as a point marker.
   * Geometry is NEVER fabricated: missing boundaries degrade to a marker.
   */
  geometryKind: 'polygon' | 'centroid';
  feature: GeoJsonFeature;
}

/** State/LGA boundary polygon from the pinned public GeoJSON (public/geo/). */
export interface StateBoundaryFeature {
  type: 'Feature';
  geometry: GeoJsonPolygonGeometry;
  properties: { name?: string; iso?: string };
}

/** Axis-aligned bounding box (WGS84 degrees). */
export interface Bbox {
  minLong: number;
  minLat: number;
  maxLong: number;
  maxLat: number;
}

/** The pinned geoBoundaries file calls the FCT 'Abuja Federal Capital Territory'. */
const STATE_ALIASES: Record<string, string> = {
  'abuja federal capital territory': 'FCT',
  'federal capital territory': 'FCT'
};

/** Normalise a raw state name to the platform's NIGERIAN_STATES spelling. */
export function canonicalStateName(raw: string): string {
  const trimmed = raw.trim();
  const alias = STATE_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

/**
 * Ray-casting point-in-polygon over GeoJSON rings (no PostGIS, no turf —
 * same algorithm as apps/api geo.service contains()).
 */
export function pointInRing(long: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] ?? [0, 0];
    const [xj, yj] = ring[j] ?? [0, 0];
    const intersects =
      yi > lat !== yj > lat && long < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygonGeometry(
  long: number,
  lat: number,
  geometry: GeoJsonPolygonGeometry
): boolean {
  const polygons =
    geometry.type === 'Polygon'
      ? ([geometry.coordinates] as number[][][][])
      : (geometry.coordinates as number[][][][]);
  return polygons.some((rings) => {
    const [outer, ...holes] = rings;
    if (!outer || !pointInRing(long, lat, outer)) return false;
    return !holes.some((hole) => pointInRing(long, lat, hole));
  });
}

/**
 * Tag a centroid with the canonical name of the state boundary containing
 * it (used for carbon plots, which carry no state column). Returns
 * undefined when the point falls outside every pinned boundary.
 */
export function stateForPoint(
  long: number,
  lat: number,
  states: StateBoundaryFeature[]
): string | undefined {
  for (const feature of states) {
    if (pointInPolygonGeometry(long, lat, feature.geometry)) {
      const name = feature.properties?.name;
      return name ? canonicalStateName(name) : undefined;
    }
  }
  return undefined;
}

function pointFeature(plot: PortalPlotBase): GeoJsonFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [plot.centroidLong, plot.centroidLat] },
    properties: {}
  };
}

interface PortalPlotBase {
  centroidLat: number;
  centroidLong: number;
}

/** Farm plot (GPS-walked boundary when present and valid). */
export function farmPlotToPortalPlot(plot: FarmPlot): PortalPlot {
  const base = {
    id: plot.id,
    source: 'farm' as const,
    name: plot.name,
    ownerUserId: plot.ownerUserId,
    state: canonicalStateName(plot.state),
    lga: plot.lga,
    hectares: plot.sizeHectares,
    centroidLat: plot.centroidLat,
    centroidLong: plot.centroidLong
  };
  if (isValidBoundaryGeojson(plot.boundaryGeojson)) {
    const geometry = plot.boundaryGeojson as GeoJsonPolygonGeometry;
    return {
      ...base,
      geometryKind: 'polygon',
      feature: {
        type: 'Feature',
        geometry,
        properties: {}
      }
    };
  }
  // Fail-closed: no fabricated boundary — centroid marker only.
  return { ...base, geometryKind: 'centroid', feature: pointFeature(base) };
}

/**
 * Carbon plot → H3 res-9 cell polygon (identical derivation to the API's
 * GET /geo/cells/:h3, computed client-side from the stored h3Res9 index).
 */
export function carbonPlotToPortalPlot(plot: CarbonPlot): PortalPlot {
  const base = {
    id: plot.id,
    source: 'carbon' as const,
    name: plot.name,
    ownerUserId: plot.ownerUserId,
    practiceType: plot.practiceType,
    hectares: plot.hectaresCenti / 100,
    centroidLat: plot.centroidLat,
    centroidLong: plot.centroidLong,
    status: plot.status,
    h3Res9: plot.h3Res9
  };
  try {
    // Guard explicitly: cellToBoundary does not throw on garbage input.
    if (!isValidCell(plot.h3Res9)) throw new Error('invalid H3 index');
    // cellToBoundary(..., true) returns [long, lat] pairs (GeoJSON order);
    // h3-js ≥4 closes the ring itself — only close when it doesn't.
    const ring = cellToBoundary(plot.h3Res9, true).map(([long, lat]) => [long, lat]);
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first.slice());
    return {
      ...base,
      geometryKind: 'polygon',
      feature: {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: {}
      }
    };
  } catch {
    // Malformed H3 index — degrade to a centroid marker rather than drop.
    return { ...base, geometryKind: 'centroid', feature: pointFeature(base) };
  }
}

/** FeatureCollection for the map source; ids/properties power click + filters. */
export function portalPlotsToFeatureCollection(
  plots: PortalPlot[],
  options: { highlightedIds?: ReadonlySet<string>; selectedId?: string } = {}
): GeoJsonFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: plots.map((plot) => ({
      ...plot.feature,
      properties: {
        id: plot.id,
        source: plot.source,
        name: plot.name,
        state: plot.state,
        practiceType: plot.practiceType,
        hectares: plot.hectares,
        geometryKind: plot.geometryKind,
        status: plot.status,
        highlighted: options.highlightedIds ? options.highlightedIds.has(plot.id) : false,
        selected: options.selectedId === plot.id
      }
    }))
  };
}

export interface PortalFilters {
  state?: string;
  practice?: string;
}

/** Client-side filter over the unified plot list (state and crop/practice). */
export function applyPortalFilters(plots: PortalPlot[], filters: PortalFilters): PortalPlot[] {
  return plots.filter((plot) => {
    if (filters.state && plot.state !== filters.state) return false;
    if (filters.practice && plot.practiceType !== filters.practice) return false;
    return true;
  });
}

/** Distinct sorted values for the filter dropdowns. */
export function distinctSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * Pure centroid-in-bbox predicate. This mirrors the DuckDB-WASM SQL in
 * spatial-query.ts exactly (centroid within the drawn box) so tests can
 * verify the semantics without loading the WASM engine in jsdom.
 */
export function plotInBbox(plot: PortalPlot, bbox: Bbox): boolean {
  return (
    plot.centroidLong >= bbox.minLong &&
    plot.centroidLong <= bbox.maxLong &&
    plot.centroidLat >= bbox.minLat &&
    plot.centroidLat <= bbox.maxLat
  );
}

/** Outer bounds of every plot centroid — used to fit the initial map view. */
export function plotsBbox(plots: PortalPlot[]): Bbox | null {
  if (plots.length === 0) return null;
  let minLong = Infinity;
  let minLat = Infinity;
  let maxLong = -Infinity;
  let maxLat = -Infinity;
  for (const plot of plots) {
    minLong = Math.min(minLong, plot.centroidLong);
    minLat = Math.min(minLat, plot.centroidLat);
    maxLong = Math.max(maxLong, plot.centroidLong);
    maxLat = Math.max(maxLat, plot.centroidLat);
  }
  return { minLong, minLat, maxLong, maxLat };
}
