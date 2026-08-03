import { describe, expect, it } from 'vitest';
import type { EquipmentBooking } from '@agric-platform/shared';
import {
  AVG_TRAVEL_SPEED_KMH,
  bufferedWindow,
  findConflicts,
  MAX_TRAVEL_BUFFER_MS,
  SUGGESTION_STEP_MS,
  suggestFreeWindows,
  travelBufferMs,
  windowsOverlap,
  withinAvailability
} from './scheduling.js';

const HOUR = 3_600_000;

function bookingAt(id: string, start: string, end: string): EquipmentBooking {
  return {
    id,
    listingId: 'mechlisting-1',
    ownerUserId: 'owner-1',
    farmerId: 'farmer-1',
    plotLat: 12,
    plotLong: 8.6,
    plotH3: '8539507fffffff',
    areaHa: 2,
    windowStart: start,
    windowEnd: end,
    status: 'confirmed',
    createdAt: start,
    updatedAt: start
  };
}

const AVAILABILITY = [{ start: '2026-09-01T00:00:00.000Z', end: '2026-12-31T23:59:59.000Z' }];

describe('travelBufferMs', () => {
  it('converts distance to time at the average travel speed', () => {
    // 40 km at 20 km/h = 2 h
    expect(travelBufferMs(40)).toBe(2 * HOUR);
    expect(AVG_TRAVEL_SPEED_KMH).toBe(20);
  });

  it('caps the buffer at the maximum', () => {
    expect(travelBufferMs(1000)).toBe(MAX_TRAVEL_BUFFER_MS);
    expect(MAX_TRAVEL_BUFFER_MS).toBe(3 * HOUR);
  });

  it('rejects invalid distances', () => {
    expect(() => travelBufferMs(-1)).toThrow(RangeError);
  });
});

describe('bufferedWindow / windowsOverlap', () => {
  it('expands the window by the buffer on both sides', () => {
    const w = bufferedWindow('2026-09-10T08:00:00.000Z', '2026-09-10T12:00:00.000Z', 40);
    expect(w.startMs).toBe(Date.parse('2026-09-10T06:00:00.000Z'));
    expect(w.endMs).toBe(Date.parse('2026-09-10T14:00:00.000Z'));
  });

  it('adjacent (touching) windows do not overlap', () => {
    const a = { startMs: 0, endMs: 100 };
    const b = { startMs: 100, endMs: 200 };
    expect(windowsOverlap(a, b)).toBe(false);
    expect(windowsOverlap(b, a)).toBe(false);
  });

  it('strictly overlapping windows overlap', () => {
    expect(windowsOverlap({ startMs: 0, endMs: 150 }, { startMs: 100, endMs: 200 })).toBe(true);
  });
});

describe('findConflicts — buffer respected both ways', () => {
  const existingBooking = bookingAt(
    'mechbooking-existing',
    '2026-09-10T08:00:00.000Z',
    '2026-09-10T12:00:00.000Z'
  );

  it('flags a genuinely overlapping candidate', () => {
    const conflicts = findConflicts(
      bufferedWindow('2026-09-10T10:00:00.000Z', '2026-09-10T14:00:00.000Z', 0),
      [{ booking: existingBooking, distanceKm: 0 }]
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].booking.id).toBe('mechbooking-existing');
  });

  it('adjacent windows with zero distance are OK', () => {
    const conflicts = findConflicts(
      bufferedWindow('2026-09-10T12:00:00.000Z', '2026-09-10T16:00:00.000Z', 0),
      [{ booking: existingBooking, distanceKm: 0 }]
    );
    expect(conflicts).toHaveLength(0);
  });

  it('the travel buffer turns an adjacent pair into a conflict', () => {
    // Both 40 km from base → 2 h buffer each side; a booking starting
    // exactly when the other ends conflicts because buffers overlap.
    const conflicts = findConflicts(
      bufferedWindow('2026-09-10T12:00:00.000Z', '2026-09-10T16:00:00.000Z', 40),
      [{ booking: existingBooking, distanceKm: 40 }]
    );
    expect(conflicts).toHaveLength(1);
  });

  it('a gap larger than both buffers is OK', () => {
    const conflicts = findConflicts(
      bufferedWindow('2026-09-10T17:00:00.000Z', '2026-09-10T21:00:00.000Z', 40),
      [{ booking: existingBooking, distanceKm: 40 }]
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('withinAvailability', () => {
  it('accepts a window fully inside an availability window', () => {
    expect(
      withinAvailability('2026-09-10T08:00:00.000Z', '2026-09-10T12:00:00.000Z', AVAILABILITY)
    ).toBe(true);
  });

  it('rejects a window that only partially overlaps availability', () => {
    expect(
      withinAvailability('2026-08-31T20:00:00.000Z', '2026-09-01T04:00:00.000Z', AVAILABILITY)
    ).toBe(false);
  });
});

describe('suggestFreeWindows — deterministic nearest-free alternatives', () => {
  const existing = [
    {
      booking: bookingAt(
        'mechbooking-existing',
        '2026-09-10T08:00:00.000Z',
        '2026-09-10T12:00:00.000Z'
      ),
      distanceKm: 0
    }
  ];

  it('skips the conflicting window and offers the next free slots', () => {
    const suggestions = suggestFreeWindows(
      '2026-09-10T08:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
      0,
      AVAILABILITY,
      existing
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].start).toBe('2026-09-10T14:00:00.000Z'); // +2×6h steps
    expect(suggestions[0].end).toBe('2026-09-10T18:00:00.000Z');
    expect(SUGGESTION_STEP_MS).toBe(6 * HOUR);
  });

  it('is deterministic: same inputs → identical suggestions', () => {
    const a = suggestFreeWindows(
      '2026-09-10T08:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
      10,
      AVAILABILITY,
      existing
    );
    const b = suggestFreeWindows(
      '2026-09-10T08:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
      10,
      AVAILABILITY,
      existing
    );
    expect(a).toEqual(b);
  });

  it('never suggests windows outside availability', () => {
    const tight = [{ start: '2026-09-10T00:00:00.000Z', end: '2026-09-10T06:00:00.000Z' }];
    const suggestions = suggestFreeWindows(
      '2026-09-10T08:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
      0,
      tight,
      []
    );
    expect(suggestions).toHaveLength(0);
  });

  it('never suggests windows in the past when nowMs is given', () => {
    const suggestions = suggestFreeWindows(
      '2026-09-10T08:00:00.000Z',
      '2026-09-10T12:00:00.000Z',
      0,
      AVAILABILITY,
      [],
      Date.parse('2026-09-15T00:00:00.000Z')
    );
    for (const suggestion of suggestions) {
      expect(Date.parse(suggestion.start)).toBeGreaterThanOrEqual(Date.parse('2026-09-15T00:00:00.000Z'));
    }
  });
});
