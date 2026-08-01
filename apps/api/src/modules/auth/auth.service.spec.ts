import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthService, OTP_MAX_ATTEMPTS } from './auth.service.js';

const PHONE = '+2348010000001'; // seeded farmer user

function makeService() {
  return new AuthService(new UsersService(), new DomainEventsService());
}

describe('AuthService OTP hardening', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.useRealTimers();
  });

  it('returns a devCode outside production and hides it in production', () => {
    process.env.NODE_ENV = 'test';
    const dev = makeService().requestOtp(PHONE);
    expect(dev.devCode).toMatch(/^\d{6}$/);

    process.env.NODE_ENV = 'production';
    const prod = makeService().requestOtp(PHONE);
    expect(prod.devCode).toBeUndefined();
    expect(prod.requestId).toBeTruthy();
    expect(prod.expiresInSeconds).toBeGreaterThan(0);
  });

  it('verifies a correct code and issues a session', () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId, devCode } = auth.requestOtp(PHONE);
    const session = auth.verifyOtp(requestId, devCode!);
    expect(session.token).toContain('stub-token.');
    expect(session.user.phone).toBe(PHONE);
  });

  it('locks the challenge after OTP_MAX_ATTEMPTS wrong codes', () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId } = auth.requestOtp(PHONE);

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      expect(() => auth.verifyOtp(requestId, '000000')).toThrowError(UnauthorizedException);
    }
    // The final allowed wrong attempt locks the challenge with a 429.
    expect(() => auth.verifyOtp(requestId, '000000')).toThrowError(/locked/);
    // Even the correct code is useless afterwards.
    expect(() => auth.verifyOtp(requestId, '000000')).toThrowError(UnauthorizedException);
  });

  it('rejects expired challenges', () => {
    process.env.NODE_ENV = 'test';
    vi.useFakeTimers();
    const auth = makeService();
    const { requestId, devCode } = auth.requestOtp(PHONE);
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(() => auth.verifyOtp(requestId, devCode!)).toThrowError(UnauthorizedException);
  });

  it('invalidates outstanding challenges when a new code is requested', () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const first = auth.requestOtp(PHONE);
    const second = auth.requestOtp(PHONE);
    expect(() => auth.verifyOtp(first.requestId, first.devCode!)).toThrowError(UnauthorizedException);
    expect(auth.verifyOtp(second.requestId, second.devCode!).user.phone).toBe(PHONE);
  });

  it('rejects verification for unknown phone numbers after a valid code', () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId, devCode } = auth.requestOtp('+2348099999999');
    expect(() => auth.verifyOtp(requestId, devCode!)).toThrowError(/No account/);
  });
});
