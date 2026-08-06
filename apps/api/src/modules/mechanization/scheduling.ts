import type { AvailabilityWindow, EquipmentBooking } from '@agric-platform/shared';

/**
 * Pure scheduling helpers (wave MECHANIZATION). One equipment unit cannot
 * hold overlapping CONFIRMED/IN_SERVICE bookings; each booking reserves its
 * service window PLUS a travel buffer on both sides (equipment must reach
 * the plot and return to base). Everything here is deterministic given the
 * same inputs — the suggestion algorithm is pinned by tests.
 */

/** Average road speed (km/h) used to convert distance into travel buffer. */
export const AVG_TRAVEL_SPEED_KMH = 20;
/** Travel buffer cap per side (ms): 3 hours, so remote plots don't lock the day. */
export const MAX_TRAVEL_BUFFER_MS = 3 * 60 * 60 * 1000;

/** One-way travel buffer in ms for a plot↔base distance, capped. */
export function travelBufferMs(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError('distanceKm must be a non-negative finite number');
  }
  return Math.min((distanceKm / AVG_TRAVEL_SPEED_KMH) * 60 * 60 * 1000, MAX_TRAVEL_BUFFER_MS);
}

export interface BufferedWindow {
  startMs: number;
  endMs: number;
}

/** Booking window expanded by its travel buffer on both sides. */
export function bufferedWindow(windowStart: string, windowEnd: string, distanceKm: number): BufferedWindow {
  const buffer = travelBufferMs(distanceKm);
  return {
    startMs: Date.parse(windowStart) - buffer,
    endMs: Date.parse(windowEnd) + buffer
  };
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function windowsOverlap(a: BufferedWindow, b: BufferedWindow): boolean {
  return a.startMs < b.endMs && a.endMs > b.startMs;
}

/**
 * True when the requested window fits entirely inside at least one of the
 * listing's availability windows.
 */
export function withinAvailability(
  windowStart: string,
  windowEnd: string,
  availability: readonly AvailabilityWindow[]
): boolean {
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  return availability.some(
    (window) => Date.parse(window.start) <= startMs && Date.parse(window.end) >= endMs
  );
}

export interface ConflictingBooking {
  booking: EquipmentBooking;
  /** Distance the existing booking buffered with (its own plot distance). */
  distanceKm: number;
}

/**
 * Returns the existing bookings whose BUFFERED windows clash with the
 * candidate's buffered window. Both sides are buffered (each booking may be
 * at a different distance from base).
 */
export function findConflicts(
  candidate: BufferedWindow,
  existing: readonly { booking: EquipmentBooking; distanceKm: number }[]
): ConflictingBooking[] {
  return existing
    .filter(({ booking, distanceKm }) =>
      windowsOverlap(candidate, bufferedWindow(booking.windowStart, booking.windowEnd, distanceKm))
    )
    .map(({ booking, distanceKm }) => ({ booking, distanceKm }));
}

/** Suggestion step: candidate start times advance in fixed 6-hour steps. */
export const SUGGESTION_STEP_MS = 6 * 60 * 60 * 1000;
/** How far ahead the suggestion search scans (28 days). */
export const SUGGESTION_HORIZON_MS = 28 * 24 * 60 * 60 * 1000;
/** Number of alternative windows offered on a 409. */
export const SUGGESTION_COUNT = 3;

export interface SuggestedWindow {
  start: string;
  end: string;
}

/**
 * Deterministic nearest-free-window search. Candidates start at
 * requestedStart + k × 6h (k = 1, 2, …) up to 28 days out; a candidate is
 * offered when it (a) fits inside an availability window and (b) its
 * buffered window clashes with no existing buffered booking. The first
 * SUGGESTION_COUNT valid candidates are returned in chronological order —
 * same bookings + same request ⇒ same suggestions, every time.
 */
export function suggestFreeWindows(
  windowStart: string,
  windowEnd: string,
  distanceKm: number,
  availability: readonly AvailabilityWindow[],
  existing: readonly { booking: EquipmentBooking; distanceKm: number }[],
  nowMs?: number
): SuggestedWindow[] {
  const durationMs = Date.parse(windowEnd) - Date.parse(windowStart);
  if (durationMs <= 0) {
    return [];
  }
  const horizonStart = Math.max(Date.parse(windowStart), nowMs ?? Number.NEGATIVE_INFINITY);
  const suggestions: SuggestedWindow[] = [];
  for (
    let startMs = Date.parse(windowStart) + SUGGESTION_STEP_MS;
    startMs <= horizonStart + SUGGESTION_HORIZON_MS && suggestions.length < SUGGESTION_COUNT;
    startMs += SUGGESTION_STEP_MS
  ) {
    if (nowMs !== undefined && startMs < nowMs) {
      continue;
    }
    const endMs = startMs + durationMs;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    if (!withinAvailability(start, end, availability)) {
      continue;
    }
    if (findConflicts(bufferedWindow(start, end, distanceKm), existing).length > 0) {
      continue;
    }
    suggestions.push({ start, end });
  }
  return suggestions;
}
