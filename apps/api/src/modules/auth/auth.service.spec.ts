import { UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import { KeyValueOtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { UsersService } from '../users/users.service.js';
import { AuthService, OTP_MAX_ATTEMPTS, OTP_PHONE_MAX_FAILURES } from './auth.service.js';
import { SessionService } from './session.service.js';

// Spy on randomInt (passthrough by default) so the leading-zero regression
// test can force a small code deterministically.
vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const PHONE = '+2348010000001'; // seeded farmer user

function makeService() {
  const users = new UsersService(createInMemoryUserRepository());
  return new AuthService(
    users,
    new DomainEventsService(createInMemoryOutboxRepository()),
    new MetricsService(),
    new KeyValueOtpChallengeStore(new InMemoryKeyValueStore()),
    new SessionService(users, createInMemoryAuthSessionRepository())
  );
}

describe('AuthService OTP hardening', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.useRealTimers();
  });

  it('returns a devCode outside production and hides it in production', async () => {
    process.env.NODE_ENV = 'test';
    const dev = await makeService().requestOtp(PHONE);
    expect(dev.devCode).toMatch(/^\d{6}$/);

    process.env.NODE_ENV = 'production';
    const prod = await makeService().requestOtp(PHONE);
    expect(prod.devCode).toBeUndefined();
    expect(prod.requestId).toBeTruthy();
    expect(prod.expiresInSeconds).toBeGreaterThan(0);
  });

  it('verifies a correct code and issues a session', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const session = await auth.verifyOtp(requestId, devCode!);
    expect(session.token).toContain('stub-token.');
    expect(session.user.phone).toBe(PHONE);
  });

  it('locks the challenge after OTP_MAX_ATTEMPTS wrong codes', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    // Codes can now carry leading zeros — pick a guess that never collides.
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const wrong = devCode === '000000' ? '000001' : '000000';

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      await expect(auth.verifyOtp(requestId, wrong)).rejects.toThrowError(UnauthorizedException);
    }
    // The final allowed wrong attempt locks the challenge with a 429.
    await expect(auth.verifyOtp(requestId, wrong)).rejects.toThrowError(/locked/);
    // Even the correct code is useless afterwards.
    await expect(auth.verifyOtp(requestId, devCode!)).rejects.toThrowError(UnauthorizedException);
  });

  it('rejects expired challenges', async () => {
    process.env.NODE_ENV = 'test';
    vi.useFakeTimers();
    const auth = makeService();
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    vi.advanceTimersByTime(6 * 60 * 1000);
    await expect(auth.verifyOtp(requestId, devCode!)).rejects.toThrowError(UnauthorizedException);
  });

  it('invalidates outstanding challenges when a new code is requested', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const first = await auth.requestOtp(PHONE);
    const second = await auth.requestOtp(PHONE);
    await expect(auth.verifyOtp(first.requestId, first.devCode!)).rejects.toThrowError(UnauthorizedException);
    expect((await auth.verifyOtp(second.requestId, second.devCode!)).user.phone).toBe(PHONE);
  });

  it('rejects verification for unknown phone numbers after a valid code', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId, devCode } = await auth.requestOtp('+2348099999999');
    await expect(auth.verifyOtp(requestId, devCode!)).rejects.toThrowError(/No account/);
  });

  it('issues codes from the full 6-digit space, including leading zeros (audit C3)', async () => {
    process.env.NODE_ENV = 'test';
    // node:crypto's randomInt is overloaded (sync + callback forms); TS picks
    // the void-returning callback overload for vi.mocked, so pin the sync
    // (min, max) => number signature before stubbing the return value.
    const randomIntMock = vi.mocked(randomInt as unknown as (min: number, max: number) => number);
    randomIntMock.mockClear();
    randomIntMock.mockReturnValueOnce(42);
    const { devCode } = await makeService().requestOtp(PHONE);
    expect(devCode).toBe('000042');
    expect(randomIntMock).toHaveBeenCalledWith(0, 1_000_000);
  });

  it('caps failed verifications per phone across reissued challenges (audit C3)', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    // Burn the per-phone budget: OTP_PHONE_MAX_FAILURES wrong guesses spread
    // across reissued challenges (5 fresh guesses per cycle without the cap).
    for (let cycle = 0; cycle < OTP_PHONE_MAX_FAILURES / OTP_MAX_ATTEMPTS; cycle += 1) {
      const { requestId, devCode } = await auth.requestOtp(PHONE);
      const wrong = devCode === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await auth.verifyOtp(requestId, wrong).catch(() => undefined);
      }
    }
    // The next challenge refuses even the correct code with a 429.
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const refused = await auth.verifyOtp(requestId, devCode!).catch((error) => error);
    expect(refused.getStatus?.()).toBe(429);
    expect(String(refused.message)).toContain('Too many failed verification attempts');
  });

  it('does not count failures against a different phone', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const other = '+2348010000002';
    const { requestId, devCode } = await auth.requestOtp(other);
    const wrong = devCode === '000000' ? '000001' : '000000';
    await auth.verifyOtp(requestId, wrong).catch(() => undefined);
    // The seeded PHONE still verifies cleanly.
    const mine = await auth.requestOtp(PHONE);
    expect((await auth.verifyOtp(mine.requestId, mine.devCode!)).user.phone).toBe(PHONE);
  });
});
