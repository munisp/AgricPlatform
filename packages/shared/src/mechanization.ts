/**
 * Wave MECHANIZATION (Innovation #10): equipment hire marketplace for
 * smallholders — cooperative/individual owners list machinery, farmers book
 * it per hectare or per hour, payment is HELD through the finance ledger
 * (stub execution mode; no real charges) and released per a deterministic
 * cancellation schedule. No PostGIS: service areas are H3 cell sets.
 */

export const EQUIPMENT_TYPES = [
  'tractor',
  'planter',
  'harvester',
  'sprayer_drone',
  'thresher'
] as const;
export type EquipmentType = (typeof EQUIPMENT_TYPES)[number];

export const EQUIPMENT_OWNER_TYPES = ['cooperative', 'individual'] as const;
export type EquipmentOwnerType = (typeof EQUIPMENT_OWNER_TYPES)[number];

export const OPERATOR_VERIFICATION_STATUSES = ['pending', 'verified', 'suspended'] as const;
export type OperatorVerificationStatus = (typeof OPERATOR_VERIFICATION_STATUSES)[number];

export const EQUIPMENT_LISTING_STATUSES = ['draft', 'active', 'paused'] as const;
export type EquipmentListingStatus = (typeof EQUIPMENT_LISTING_STATUSES)[number];

export const MECH_BOOKING_STATUSES = [
  'requested',
  'quoted',
  'confirmed',
  'in_service',
  'completed',
  'rated',
  'cancelled',
  'disputed'
] as const;
export type MechBookingStatus = (typeof MECH_BOOKING_STATUSES)[number];

/** Weekly availability window (ISO 8601 instants) within which bookings may fall. */
export interface AvailabilityWindow {
  start: string;
  end: string;
}

export interface EquipmentRates {
  /** ₦ per hectare (optional — at least one of perHa/perHour required). */
  perHaNaira?: number;
  /** ₦ per service hour (optional). */
  perHourNaira?: number;
  /** ₦ per km beyond the included travel radius (0 = no surcharge). */
  perKmNaira: number;
  /** Travel distance included in the base price, in km. */
  includedKm: number;
}

export interface EquipmentListing {
  id: string;
  ownerUserId: string;
  ownerType: EquipmentOwnerType;
  type: EquipmentType;
  title: string;
  description: string;
  /** Free-form specs (horsepower, capacity, drone model, …). */
  specs: Record<string, unknown>;
  /** Equipment base location (travel surcharge + buffers anchor here). */
  baseLat: number;
  baseLong: number;
  /** H3 cells (all at serviceAreaResolution, res 5–7) the owner serves. */
  serviceAreaH3: string[];
  serviceAreaResolution: number;
  rates: EquipmentRates;
  availability: AvailabilityWindow[];
  /** Uploaded operator licence reference (document id — never a URL to PII). */
  operatorLicenseRef?: string;
  operatorVerification: OperatorVerificationStatus;
  status: EquipmentListingStatus;
  createdAt: string;
  updatedAt: string;
}

/** Itemised quote produced by the pure pricing engine (integer kobo). */
export interface MechQuoteBreakdown {
  /** area_ha × per_ha rate (0 when not billed per hectare). */
  areaComponentKobo: number;
  /** hours × per_hour rate (0 when not billed per hour). */
  hourComponentKobo: number;
  /** (distance − includedKm)⁺ × per_km rate. */
  distanceSurchargeKobo: number;
  /** Plot ↔ equipment base great-circle distance used above. */
  distanceKm: number;
  /** Seasonal multiplier applied to (base + surcharge). */
  seasonalMultiplier: number;
  /** Calendar month (1–12) that selected the multiplier. */
  seasonalMonth: number;
  /** Pre-multiplier subtotal. */
  subtotalKobo: number;
  /** Final quoted total. */
  totalKobo: number;
  quotedAt: string;
}

/** Weather/flood advisory carried on a quote — advisory only, never blocks. */
export interface MechAdvisory {
  severe: boolean;
  /** Honest provenance: which port/driver produced this ('none-configured' when unchecked). */
  basis: string;
  severity?: string;
  h3Cell?: string;
}

export interface EquipmentBooking {
  id: string;
  listingId: string;
  ownerUserId: string;
  farmerId: string;
  /** Farmer plot reference (farms module plot id when picked, else free point). */
  plotId?: string;
  plotLat: number;
  plotLong: number;
  /** H3 cell of the plot at the listing's service-area resolution. */
  plotH3: string;
  areaHa: number;
  /** Billed hours (required when the listing bills per_hour). */
  estimatedHours?: number;
  windowStart: string;
  windowEnd: string;
  status: MechBookingStatus;
  quote?: MechQuoteBreakdown;
  advisory?: MechAdvisory;
  /** Ledger journal entry id of the payment hold (stub execution mode). */
  holdEntryId?: string;
  farmerConfirmedCompletionAt?: string;
  ownerConfirmedCompletionAt?: string;
  rating?: number;
  reviewComment?: string;
  cancelledBy?: 'farmer' | 'owner' | 'admin';
  cancelReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Derived (never stored) per-owner utilisation rollup. */
export interface OwnerUtilizationStats {
  ownerUserId: string;
  listingCount: number;
  bookedHours: number;
  completedBookings: number;
  cancelledBookings: number;
  disputedBookings: number;
  /** 0–1: completed+rated over terminal bookings (completed, rated, cancelled, disputed). */
  completionRate: number;
  /** Sum of hold amounts actually released to the owner (kobo). */
  revenueClearedKobo: number;
}
