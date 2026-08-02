import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import { KeyValueOtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { UsersService } from '../users/users.service.js';
import { AuthService, OTP_MAX_ATTEMPTS } from './auth.service.js';

const PHONE = '+2348010000001'; // seeded farmer user

function makeService() {
  return new AuthService(
    new UsersService(createInMemoryUserRepository()),
    new DomainEventsService(createInMemoryOutboxRepository()),
    new MetricsService(),
    new KeyValueOtpChallengeStore(new InMemoryKeyValueStore())
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
    const { requestId } = await auth.requestOtp(PHONE);

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      await expect(auth.verifyOtp(requestId, '000000')).rejects.toThrowError(UnauthorizedException);
    }
    // The final allowed wrong attempt locks the challenge with a 429.
    await expect(auth.verifyOtp(requestId, '000000')).rejects.toThrowError(/locked/);
    // Even the correct code is useless afterwards.
    await expect(auth.verifyOtp(requestId, '000000')).rejects.toThrowError(UnauthorizedException);
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
});
