/**
 * Farms & crop-production domain primitives — farms wave (migration 022,
 * farms schema). Merged from the farmer-data-collection domain model
 * (plots with lat/long centroid + GeoJSON boundary, crop plantings,
 * harvests, expenses) and rewritten onto AgricPlatform conventions:
 * text PKs, owner scoping, offline-sync metadata (version + clientId).
 */

export const PLANTING_STATUSES = ['growing', 'harvested', 'failed'] as const;
export type PlantingStatus = (typeof PLANTING_STATUSES)[number];

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

export interface FarmExpense {
  id: string;
  plotId: string;
  category: FarmExpenseCategory;
  /** Minor units (kobo) — money never crosses the wire as a float. */
  amountKobo: number;
  incurredAt: string;
  note?: string;
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
