import { describe, expect, it } from 'vitest';
import { DEV_ATTENDANCE_SECRET, resolveAttendanceSecret } from './attendance.config.js';

describe('resolveAttendanceSecret', () => {
  it('returns the configured secret outside production', () => {
    expect(
      resolveAttendanceSecret({ NODE_ENV: 'development', ATTENDANCE_SIGNING_SECRET: 'x'.repeat(32) })
    ).toBe('x'.repeat(32));
  });

  it('falls back to the dev-only secret outside production when unset', () => {
    expect(resolveAttendanceSecret({ NODE_ENV: 'development' })).toBe(DEV_ATTENDANCE_SECRET);
  });

  it('fails closed in production when the secret is missing', () => {
    expect(() => resolveAttendanceSecret({ NODE_ENV: 'production' })).toThrow(
      /ATTENDANCE_SIGNING_SECRET/
    );
  });

  it('fails closed in production when the secret is too short', () => {
    expect(() =>
      resolveAttendanceSecret({ NODE_ENV: 'production', ATTENDANCE_SIGNING_SECRET: 'short' })
    ).toThrow(/ATTENDANCE_SIGNING_SECRET/);
  });

  it('accepts a strong secret in production', () => {
    expect(
      resolveAttendanceSecret({ NODE_ENV: 'production', ATTENDANCE_SIGNING_SECRET: 'y'.repeat(48) })
    ).toBe('y'.repeat(48));
  });
});
