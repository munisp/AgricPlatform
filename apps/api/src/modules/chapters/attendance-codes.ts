import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed QR attendance codes for chapter events (Wave P3).
 *
 * A code embeds the event id and a rotating 15-minute nonce window and is
 * authenticated with HMAC-SHA256 keyed by ATTENDANCE_SIGNING_SECRET (see
 * config/attendance.config.ts). Format:
 *
 *   v1.<eventId>.<window>.<base64url-hmac>
 *
 * Verification accepts the current window plus one rotation of grace (the
 * immediately previous window) so a QR projected at an event does not go
 * stale exactly on the 15-minute boundary; anything older is rejected as
 * expired. Signature comparison is constant-time.
 */
export const ATTENDANCE_CODE_VERSION = 'v1';
export const ATTENDANCE_WINDOW_MS = 15 * 60 * 1000; // 15-minute rotating nonce window
/** Current window plus one rotation of grace. */
export const ATTENDANCE_ACCEPTED_WINDOWS = 2;

export interface AttendanceCode {
  /** Full encoded code string to embed in the QR payload. */
  code: string;
  eventId: string;
  /** Nonce window index (floor(timestamp / ATTENDANCE_WINDOW_MS)). */
  window: number;
  issuedAt: string;
  /** End of the grace window; scans after this instant are rejected. */
  expiresAt: string;
}

export type AttendanceCodeFailure = 'malformed' | 'wrong_event' | 'signature' | 'expired';

export type AttendanceCodeVerification =
  | { ok: true; eventId: string; window: number }
  | { ok: false; reason: AttendanceCodeFailure };

export function attendanceWindow(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / ATTENDANCE_WINDOW_MS);
}

/** HMAC-SHA256 signature over version.eventId.window (base64url). */
export function signAttendanceCode(eventId: string, window: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${ATTENDANCE_CODE_VERSION}.${eventId}.${window}`)
    .digest('base64url');
}

/** Issue a signed attendance code for an event at the current window. */
export function generateAttendanceCode(
  eventId: string,
  secret: string,
  nowMs: number = Date.now()
): AttendanceCode {
  const window = attendanceWindow(nowMs);
  const signature = signAttendanceCode(eventId, window, secret);
  return {
    code: `${ATTENDANCE_CODE_VERSION}.${eventId}.${window}.${signature}`,
    eventId,
    window,
    issuedAt: new Date(window * ATTENDANCE_WINDOW_MS).toISOString(),
    expiresAt: new Date((window + ATTENDANCE_ACCEPTED_WINDOWS) * ATTENDANCE_WINDOW_MS).toISOString()
  };
}

/**
 * Verify a scanned code: structure, event binding, HMAC signature and the
 * rotating-window expiry. `expectedEventId` binds the code to the event being
 * scanned so a code for event A cannot check anyone into event B.
 */
export function verifyAttendanceCode(
  code: string,
  expectedEventId: string,
  secret: string,
  nowMs: number = Date.now()
): AttendanceCodeVerification {
  const parts = code.split('.');
  if (parts.length < 4 || parts[0] !== ATTENDANCE_CODE_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const signature = parts[parts.length - 1];
  const windowRaw = parts[parts.length - 2];
  const eventId = parts.slice(1, -2).join('.');
  const window = Number(windowRaw);
  if (!signature || !eventId || !Number.isSafeInteger(window) || window < 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (eventId !== expectedEventId) {
    return { ok: false, reason: 'wrong_event' };
  }
  const expected = signAttendanceCode(eventId, window, secret);
  const providedBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'signature' };
  }
  const current = attendanceWindow(nowMs);
  if (window > current || current - window >= ATTENDANCE_ACCEPTED_WINDOWS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, eventId, window };
}
