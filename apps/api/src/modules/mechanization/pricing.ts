import type { EquipmentRates, MechQuoteBreakdown } from '@agric-platform/shared';

/**
 * Pure pricing engine (wave MECHANIZATION). No I/O, no clock except the
 * booking window passed in — every component is deterministic and pinned by
 * known-answer tests. All money is integer kobo; rates arrive in ₦ and are
 * converted once (rounded) before any multiplication.
 *
 * Quote = (areaComponent + hourComponent + distanceSurcharge) × seasonalMultiplier
 *
 *   areaComponent     = area_ha × per_ha rate            (0 when no per_ha rate)
 *   hourComponent     = estimated_hours × per_hour rate  (0 when no per_hour rate)
 *   distanceSurcharge = max(0, distanceKm − includedKm) × per_km rate
 *   seasonalMultiplier = month of windowStart via SEASONAL_MULTIPLIERS
 *
 * When a listing carries BOTH per_ha and per_hour rates the two components
 * are summed (owner prices machine-hours AND hectares — e.g. drone spray
 * passes); at least one component must be positive.
 */

/** Great-circle distance in kilometres (haversine, R = 6371 km). */
export function haversineKm(aLat: number, aLong: number, bLat: number, bLong: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLong = (bLong - aLong) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLong / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Seasonal demand multipliers keyed by calendar month (1–12), anchored to
 * the Nigerian cropping calendar: pre-planting land prep peaks March–May,
 * planting/weeding June–July, harvest October–December. Values are a static
 * operator table — tune here, not per listing, so quotes stay comparable.
 */
export const SEASONAL_MULTIPLIERS: Readonly<Record<number, number>> = {
  1: 1.1, // dry-season land clearing
  2: 1.1,
  3: 1.25, // pre-planting land prep peak
  4: 1.3, // planting window opens (wet season onset)
  5: 1.3, // peak planting
  6: 1.2, // planting/weeding
  7: 1.15,
  8: 1.0, // mid-season lull
  9: 1.05,
  10: 1.2, // main harvest
  11: 1.25, // peak harvest / threshing
  12: 1.15
};

export function seasonalMultiplierForMonth(month: number): number {
  const multiplier = SEASONAL_MULTIPLIERS[month];
  if (multiplier === undefined) {
    throw new RangeError(`month must be 1–12, got ${month}`);
  }
  return multiplier;
}

export interface QuoteInput {
  rates: EquipmentRates;
  areaHa: number;
  estimatedHours?: number;
  /** Plot ↔ equipment base distance in km (haversine). */
  distanceKm: number;
  /** ISO instant — the calendar month selects the seasonal multiplier. */
  windowStart: string;
  /** Clock injectable for deterministic tests. */
  quotedAt?: string;
}

/** Converts a ₦ rate to integer kobo once (rounded), the only ₦→kobo step. */
function rateToKobo(rateNaira: number): number {
  return Math.round(rateNaira * 100);
}

export function computeQuote(input: QuoteInput): MechQuoteBreakdown {
  const { rates, areaHa, estimatedHours, distanceKm, windowStart } = input;
  if (!Number.isFinite(areaHa) || areaHa <= 0) {
    throw new RangeError('areaHa must be a positive finite number');
  }
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError('distanceKm must be a non-negative finite number');
  }
  const hasPerHa = typeof rates.perHaNaira === 'number' && rates.perHaNaira > 0;
  const hasPerHour = typeof rates.perHourNaira === 'number' && rates.perHourNaira > 0;
  if (!hasPerHa && !hasPerHour) {
    throw new RangeError('listing must carry a per_ha and/or per_hour rate');
  }
  if (hasPerHour && (estimatedHours === undefined || estimatedHours <= 0)) {
    throw new RangeError('estimatedHours is required when the listing bills per_hour');
  }

  const areaComponentKobo = hasPerHa ? Math.round(areaHa * rateToKobo(rates.perHaNaira!)) : 0;
  const hourComponentKobo = hasPerHour
    ? Math.round(estimatedHours! * rateToKobo(rates.perHourNaira!))
    : 0;
  const extraKm = Math.max(0, distanceKm - rates.includedKm);
  const distanceSurchargeKobo = Math.round(extraKm * rateToKobo(rates.perKmNaira));
  const subtotalKobo = areaComponentKobo + hourComponentKobo + distanceSurchargeKobo;
  const month = new Date(windowStart).getUTCMonth() + 1;
  const seasonalMultiplier = seasonalMultiplierForMonth(month);
  const totalKobo = Math.round(subtotalKobo * seasonalMultiplier);

  return {
    areaComponentKobo,
    hourComponentKobo,
    distanceSurchargeKobo,
    distanceKm: Math.round(distanceKm * 100) / 100,
    seasonalMultiplier,
    seasonalMonth: month,
    subtotalKobo,
    totalKobo,
    quotedAt: input.quotedAt ?? new Date().toISOString()
  };
}
