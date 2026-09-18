/**
 * Farms & crop-production domain primitives — farms wave (migration 022,
 * farms schema). Merged from the farmer-data-collection domain model
 * (plots with lat/long centroid + GeoJSON boundary, crop plantings,
 * harvests, expenses) and rewritten onto AgricPlatform conventions:
 * text PKs, owner scoping, offline-sync metadata (version + clientId).
 */

export const PLANTING_STATUSES = [
  'growing',
  /** One or more picks recorded, more expected (A3) — still an active crop. */
  'partially_harvested',
  'harvested',
  'failed'
] as const;
export type PlantingStatus = (typeof PLANTING_STATUSES)[number];

/**
 * Why a planting failed (V-03 contract input). Recorded on the planting row
 * and carried by the `farms.planting.status_changed` (→ failed) event so
 * downstream subscribers (e.g. crop-failure→loan grace) can act without
 * re-querying the farms module.
 */
export const PLANTING_FAILURE_REASONS = [
  'drought',
  'flood',
  'pests',
  'disease',
  'input_failure',
  'other'
] as const;
export type PlantingFailureReason = (typeof PLANTING_FAILURE_REASONS)[number];

export const HARVEST_UNITS = ['kg', 'tonnes', 'bags', 'crates', 'bunches'] as const;
export type HarvestUnit = (typeof HARVEST_UNITS)[number];

export const HARVEST_QUALITY_GRADES = ['A', 'B', 'C', 'rejects'] as const;
export type HarvestQualityGrade = (typeof HARVEST_QUALITY_GRADES)[number];

export const FARM_EXPENSE_CATEGORIES = [
  'seeds',
  'fertilizer',
  'pesticides',
  'labour',
  'equipment',
  'irrigation',
  'transport',
  'other'
] as const;
export type FarmExpenseCategory = (typeof FARM_EXPENSE_CATEGORIES)[number];

export const SOIL_TYPES = [
  'loamy',
  'sandy',
  'clay',
  'silty',
  'peaty',
  'chalky'
] as const;
export type SoilType = (typeof SOIL_TYPES)[number];

/**
 * A registered farm plot. `boundaryGeojson` holds the raw GeoJSON geometry
 * (Polygon/MultiPolygon) captured by walking the perimeter; stored as JSONB
 * — no PostGIS dependency. `version`/`clientId` support offline-first sync
 * merges from the mobile capture app.
 */
export interface FarmPlot {
  id: string;
  ownerUserId: string;
  name: string;
  state: string;
  lga: string;
  centroidLat: number;
  centroidLong: number;
  boundaryGeojson?: unknown;
  sizeHectares: number;
  soilType?: SoilType;
  createdAt: string;
  updatedAt: string;
  version: number;
  clientId?: string;
}

export interface CropPlanting {
  id: string;
  plotId: string;
  crop: string;
  variety?: string;
  season: string;
  plantedAt: string;
  expectedHarvestAt?: string;
  status: PlantingStatus;
  /**
   * Replant linkage (A2): when this planting replaces a FAILED predecessor
   * on the same plot, the predecessor's id — failure → replant history is
   * traceable instead of the two plantings looking unrelated.
   */
  replantOfId?: string;
  /** Set when status transitions to 'failed' (see PLANTING_FAILURE_REASONS). */
  failureReason?: PlantingFailureReason;
  createdAt: string;
  updatedAt: string;
  version: number;
  clientId?: string;
}

export interface HarvestRecord {
  id: string;
  plantingId: string;
  harvestedAt: string;
  quantity: number;
  unit: HarvestUnit;
  qualityGrade?: HarvestQualityGrade;
  createdAt: string;
}

/**
 * Intercrop expense allocation (A4): an explicit per-planting share of a
 * plot expense. `sharePercent` is a percentage of `amountKobo`; a fully
 * allocated expense's shares sum to exactly 100.
 */
export interface FarmExpenseAllocation {
  plantingId: string;
  sharePercent: number;
}

export interface FarmExpense {
  id: string;
  plotId: string;
  category: FarmExpenseCategory;
  /** Minor units (kobo) — money never crosses the wire as a float. */
  amountKobo: number;
  incurredAt: string;
  note?: string;
  /**
   * Explicit per-planting allocation (A4) for intercropped plots. Absent =
   * PLOT-LEVEL expense: it is NOT attributed to any single crop; per-crop
   * P&L must treat it as shared across the plot (the documented default
   * rule — never silently full-attribute to one planting).
   */
  allocations?: FarmExpenseAllocation[];
  createdAt: string;
}

/** Per-owner aggregates behind GET /farms/summary. */
export interface FarmSummary {
  ownerUserId: string;
  plotCount: number;
  totalHectares: number;
  activePlantings: number;
  /** Total harvested quantity per crop (all units summed per crop). */
  harvestByCrop: Array<{ crop: string; totalQuantity: number; harvestCount: number }>;
  totalExpensesKobo: number;
}

/**
 * Minimal structural validation for boundary GeoJSON: an object whose
 * `type` is Polygon or MultiPolygon with a coordinates array. Deeper
 * geometry checks stay the client's job (no PostGIS server-side).
 */
export function isValidBoundaryGeojson(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { type?: unknown; coordinates?: unknown };
  return (
    (candidate.type === 'Polygon' || candidate.type === 'MultiPolygon') &&
    Array.isArray(candidate.coordinates)
  );
}
