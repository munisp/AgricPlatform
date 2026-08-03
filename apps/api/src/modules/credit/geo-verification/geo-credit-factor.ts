/**
 * Geo-verified credit factor (wave-geocredit) — the deterministic sixth
 * credit-scoring factor, derived from geospatial plot verification. This
 * module is PURE: no I/O, no clocks, no randomness. `nowIso` is an input,
 * so the same inputs always produce the same outputs (unit-testable
 * known-answer vectors).
 *
 * SHADOW MODE: the score is persisted only to credit.geo_credit_shadow_scores
 * and never read by the live approve/decline path. Activation as a real
 * sixth factor requires model validation + fair-lending legal review
 * (docs/geo-verified-credit.md).
 */
import type { GeoCreditFactorBreakdown } from '@agric-platform/shared';

/* ------------------------------------------------------------- weights --

 * Weighting table (max 100). Rationale:
 *
 *   plotVerification  25  Binary gate: a geolocated plot owned by the
 *                         applicant exists at all. Heaviest single signal —
 *                         the factor's whole premise is "the farm is real".
 *   areaPlausibility  15  Stored plot area inside the plausible smallholder
 *                         band (0.01–100 ha). Catches fat-fingered or
 *                         fabricated geometry without punishing odd sizes
 *                         beyond a bounded amount.
 *   floodRisk         20  Geo-intel flood band. A severely flood-exposed
 *                         plot is a genuine repayment-risk signal, but
 *                         capped below crop health because the flood model
 *                         itself ships unvalidated (often stub).
 *   cropHealth        30  crop-ml health_score (0–100) scaled to 0–30.
 *                         The most direct "is something actually growing"
 *                         signal, so the largest weight.
 *   dataFreshness     10  Recency of the underlying plot record; stale
 *                         verification is worth less. Small weight so old
 *                         but real farms are discounted, not excluded.
 */
export const GEO_CREDIT_WEIGHTS = {
  plotVerification: 25,
  areaPlausibility: 15,
  floodRisk: 20,
  cropHealth: 30,
  dataFreshness: 10
} as const;

export const GEO_CREDIT_FACTOR_MAX = 100;

/** Plausible smallholder plot band in hectares (inclusive). */
export const PLOT_AREA_MIN_HA = 0.01;
export const PLOT_AREA_MAX_HA = 100;

export type FloodRiskBand = 'none' | 'low' | 'moderate' | 'high' | 'severe';

/** Flood band → points (of GEO_CREDIT_WEIGHTS.floodRisk). */
export const FLOOD_BAND_POINTS: Readonly<Record<FloodRiskBand, number>> = {
  none: 20,
  low: 16,
  moderate: 10,
  high: 5,
  severe: 0
};

/**
 * Maps a flood-risk severity string (geo-intel port: 'none' | 'low' |
 * 'moderate' | 'high' | 'severe') onto a band. Unrecognised severities map
 * to 'moderate' — the neutral middle, neither rewarding nor punishing an
 * unverifiable label.
 */
export function floodBandFromSeverity(severity: string): FloodRiskBand {
  switch (severity) {
    case 'none':
    case 'low':
    case 'moderate':
    case 'high':
    case 'severe':
      return severity;
    default:
      return 'moderate';
  }
}

/** Freshness bands: age in days of the plot record → points (max 10). */
export const FRESHNESS_BANDS: ReadonlyArray<{ maxAgeDays: number; points: number }> = [
  { maxAgeDays: 30, points: 10 },
  { maxAgeDays: 90, points: 7 },
  { maxAgeDays: 180, points: 4 },
  { maxAgeDays: 365, points: 2 }
];

export function freshnessPoints(ageDays: number): number {
  for (const band of FRESHNESS_BANDS) {
    if (ageDays <= band.maxAgeDays) {
      return band.points;
    }
  }
  return 0;
}

export interface GeoCreditFactorInput {
  /** Plot exists, carries centroid coordinates and belongs to the applicant. */
  plotVerified: boolean;
  /** Hectares from the stored geometry (boundary estimate, else declared size). */
  areaHectares: number | null;
  floodBand: FloodRiskBand;
  /** crop-ml health_score 0–100; null when the crop input is unavailable. */
  cropHealthScore: number | null;
  /** ISO timestamp of the underlying plot record (updatedAt), else null. */
  plotUpdatedAt: string | null;
}

export interface GeoCreditFactorResult {
  score: number;
  breakdown: GeoCreditFactorBreakdown;
}

const DAY_MS = 86_400_000;

/**
 * Pure factor computation. Every component boundary is exercised by the
 * known-answer vectors in geo-credit-factor.spec.ts.
 */
export function computeGeoCreditFactor(
  input: GeoCreditFactorInput,
  nowIso: string
): GeoCreditFactorResult {
  const plotVerification = input.plotVerified ? GEO_CREDIT_WEIGHTS.plotVerification : 0;

  const areaPlausible =
    input.plotVerified &&
    input.areaHectares !== null &&
    input.areaHectares >= PLOT_AREA_MIN_HA &&
    input.areaHectares <= PLOT_AREA_MAX_HA;
  const areaPlausibility = areaPlausible ? GEO_CREDIT_WEIGHTS.areaPlausibility : 0;

  const floodRisk = input.plotVerified ? FLOOD_BAND_POINTS[input.floodBand] : 0;

  const health = input.cropHealthScore;
  const cropHealth =
    input.plotVerified && health !== null
      ? Math.round((Math.min(100, Math.max(0, health)) / 100) * GEO_CREDIT_WEIGHTS.cropHealth)
      : 0;

  let dataFreshness = 0;
  if (input.plotVerified && input.plotUpdatedAt) {
    const ageDays = Math.max(0, (Date.parse(nowIso) - Date.parse(input.plotUpdatedAt)) / DAY_MS);
    dataFreshness = freshnessPoints(ageDays);
  }

  const breakdown: GeoCreditFactorBreakdown = {
    plotVerification,
    areaPlausibility,
    floodRisk,
    cropHealth,
    dataFreshness
  };
  const score = Math.min(
    GEO_CREDIT_FACTOR_MAX,
    Math.max(
      0,
      plotVerification + areaPlausibility + floodRisk + cropHealth + dataFreshness
    )
  );
  return { score, breakdown };
}

/* ------------------------------------------- geometry area estimation -- */

interface GeoJsonPosition {
  0: number;
  1: number;
}

function isPosition(value: unknown): value is GeoJsonPosition {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

/**
 * Approximate area (hectares) of a GeoJSON Polygon/MultiPolygon boundary via
 * the shoelace formula on an equirectangular projection centred on the
 * geometry's mean latitude. Deterministic and dependency-free (no PostGIS);
 * accurate to ~1% for smallholder-sized plots. Returns null for missing or
 * structurally invalid geometry.
 */
export function estimateBoundaryAreaHectares(boundaryGeojson: unknown): number | null {
  if (typeof boundaryGeojson !== 'object' || boundaryGeojson === null) {
    return null;
  }
  const geometry = boundaryGeojson as { type?: unknown; coordinates?: unknown };
  const polygons: unknown[] =
    geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)
        ? (geometry.coordinates as unknown[])
        : [];
  if (polygons.length === 0) {
    return null;
  }

  let totalM2 = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) continue;
    const rings = polygon.filter(Array.isArray) as unknown[][];
    const outer = rings[0]?.filter(isPosition) ?? [];
    if (outer.length < 3) continue;
    const meanLat =
      outer.reduce((sum, position) => sum + position[1], 0) / outer.length;
    const ringArea = (ring: GeoJsonPosition[]): number => {
      const metresPerDegLat = 111_320;
      const metresPerDegLong = 111_320 * Math.cos((meanLat * Math.PI) / 180);
      let sum = 0;
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        sum +=
          a[0] * metresPerDegLong * (b[1] * metresPerDegLat) -
          b[0] * metresPerDegLong * (a[1] * metresPerDegLat);
      }
      return Math.abs(sum) / 2;
    };
    let areaM2 = ringArea(outer);
    for (const hole of rings.slice(1)) {
      const positions = hole.filter(isPosition);
      if (positions.length >= 3) {
        areaM2 -= ringArea(positions);
      }
    }
    totalM2 += Math.max(0, areaM2);
  }
  if (totalM2 <= 0) {
    return null;
  }
  return Math.round((totalM2 / 10_000) * 10_000) / 10_000;
}

/* ------------------------------------------------------ input fingerprint -- */

/** FNV-1a hex digest over the canonical input string. */
export function computeInputFingerprint(parts: readonly (string | number | null)[]): string {
  const canonical = parts.map((part) => (part === null ? '∅' : String(part))).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
