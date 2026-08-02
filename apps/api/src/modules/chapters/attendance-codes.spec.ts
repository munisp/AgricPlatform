import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_WINDOW_MS,
  attendanceWindow,
  generateAttendanceCode,
  signAttendanceCode,
  verifyAttendanceCode
} from './attendance-codes.js';

const SECRET = 'test-attendance-secret-0123456789';
const EVENT = 'event-harvest-training';
const NOW = 1_800_000_000_000; // fixed timestamp for deterministic windows

describe('attendance QR codes', () => {
  it('signs deterministically for the same event and window', () => {
    const window = attendanceWindow(NOW);
    expect(signAttendanceCode(EVENT, window, SECRET)).toBe(signAttendanceCode(EVENT, window, SECRET));
    expect(signAttendanceCode(EVENT, window, SECRET)).not.toBe(
      signAttendanceCode(EVENT, window + 1, SECRET)
    );
    expect(signAttendanceCode(EVENT, window, SECRET)).not.toBe(
      signAttendanceCode('event-other', window, SECRET)
    );
  });

  it('round-trips a freshly generated code', () => {
    const issued = generateAttendanceCode(EVENT, SECRET, NOW);
    const result = verifyAttendanceCode(issued.code, EVENT, SECRET, NOW);
    expect(result).toEqual({ ok: true, eventId: EVENT, window: attendanceWindow(NOW) });
    expect(issued.expiresAt).toBe(new Date((attendanceWindow(NOW) + 2) * ATTENDANCE_WINDOW_MS).toISOString());
  });

  it('accepts the previous window (one rotation of grace)', () => {
    const previousWindowStart = attendanceWindow(NOW) * ATTENDANCE_WINDOW_MS - 1;
    const issued = generateAttendanceCode(EVENT, SECRET, previousWindowStart);
    expect(verifyAttendanceCode(issued.code, EVENT, SECRET, NOW)).toMatchObject({ ok: true });
  });

  it('rejects codes older than the grace window as expired', () => {
    const twoWindowsAgo = NOW - 2 * ATTENDANCE_WINDOW_MS;
    const issued = generateAttendanceCode(EVENT, SECRET, twoWindowsAgo);
    expect(verifyAttendanceCode(issued.code, EVENT, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'expired'
    });
  });

  it('rejects codes from a future window as expired', () => {
    const issued = generateAttendanceCode(EVENT, SECRET, NOW + ATTENDANCE_WINDOW_MS);
    expect(verifyAttendanceCode(issued.code, EVENT, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'expired'
    });
  });

  it('rejects a tampered signature', () => {
    const issued = generateAttendanceCode(EVENT, SECRET, NOW);
    const tampered = `${issued.code.slice(0, -2)}${issued.code.endsWith('a') ? 'b' : 'a'}x`;
    expect(verifyAttendanceCode(tampered, EVENT, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature'
    });
  });

  it('rejects a code signed with a different secret', () => {
    const issued = generateAttendanceCode(EVENT, 'another-secret-0123456789', NOW);
    expect(verifyAttendanceCode(issued.code, EVENT, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'signature'
    });
  });

  it('rejects a code scanned against the wrong event', () => {
    const issued = generateAttendanceCode(EVENT, SECRET, NOW);
    expect(verifyAttendanceCode(issued.code, 'event-other', SECRET, NOW)).toEqual({
      ok: false,
      reason: 'wrong_event'
    });
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', 'v1', 'v2.event.1.abc', 'v1..1.abc', 'v1.event.notanumber.abc', 'v1.event.-1.abc']) {
      expect(verifyAttendanceCode(bad, EVENT, SECRET, NOW).ok).toBe(false);
    }
  });

  it('supports event ids containing dots', () => {
    const issued = generateAttendanceCode('event.lagos.2026', SECRET, NOW);
    expect(verifyAttendanceCode(issued.code, 'event.lagos.2026', SECRET, NOW)).toMatchObject({
      ok: true,
      eventId: 'event.lagos.2026'
    });
  });
});
