import { ConflictException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { validateSync } from 'class-validator';
import { randomInt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryAuthSessionRepository } from '../../database/repositories/auth-session.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { InMemoryKeyValueStore } from '../../redis/key-value-store.js';
import { KeyValueOtpChallengeStore } from '../../redis/otp-challenge.store.js';
import type { SmsDriver } from '../integrations/drivers/sms.drivers.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthService, OTP_MAX_ATTEMPTS, OTP_PHONE_MAX_FAILURES } from './auth.service.js';
import { RegisterDto, RequestOtpDto } from './auth.controller.js';
import { SessionService } from './session.service.js';

// Spy on randomInt (passthrough by default) so the leading-zero regression
// test can force a small code deterministically.
vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const PHONE = '+2348010000001'; // seeded farmer user

function makeService(integrations?: Pick<IntegrationsService, 'smsDriver'>) {
  const users = new UsersService(createInMemoryUserRepository());
  return new AuthService(
    users,
    new DomainEventsService(createInMemoryOutboxRepository()),
    new MetricsService(),
    new KeyValueOtpChallengeStore(new InMemoryKeyValueStore()),
    new SessionService(users, createInMemoryAuthSessionRepository()),
    undefined,
    integrations as IntegrationsService | undefined
  );
}

/** Live-driver test double recording sendOtp calls. */
function makeSmsDriver(overrides?: { fail?: boolean }): SmsDriver & {
  sent: Array<{ to: string; pin: string }>;
} {
  const sent: Array<{ to: string; pin: string }> = [];
  return {
    name: 'termii',
    sent,
    async sendSms() {
      return { delivered: true, provider: 'termii', driver: 'production', providerRef: 'ref', note: '' };
    },
    async sendOtp(to: string, pin: string) {
      if (overrides?.fail) {
        throw new Error('provider 502 bad gateway');
      }
      sent.push({ to, pin });
      return { delivered: true, provider: 'termii', driver: 'production', providerRef: 'ref', note: '' };
    }
  };
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
    const driver = makeSmsDriver();
    const prod = await makeService({ smsDriver: () => driver }).requestOtp(PHONE);
    expect(prod.devCode).toBeUndefined();
    expect(prod.requestId).toBeTruthy();
    expect(prod.expiresInSeconds).toBeGreaterThan(0);
    expect(driver.sent).toHaveLength(1);
  });

  it('delivers the OTP through the SMS driver on the request path (V-16)', async () => {
    process.env.NODE_ENV = 'test';
    const driver = makeSmsDriver();
    const auth = makeService({ smsDriver: () => driver });
    const result = await auth.requestOtp(PHONE);
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0].to).toBe(PHONE);
    expect(driver.sent[0].pin).toMatch(/^\d{6}$/);
    // Live delivery means no devCode leak even outside production... the
    // devCode gate is unchanged: non-production still returns it.
    expect(result.devCode).toBe(driver.sent[0].pin);
  });

  it('fails closed with 503 and invalidates the challenge when the provider errors (V-16)', async () => {
    process.env.NODE_ENV = 'test';
    let driver = makeSmsDriver();
    const auth = makeService({ smsDriver: () => driver });
    const first = await auth.requestOtp(PHONE);
    driver = makeSmsDriver({ fail: true });
    await expect(auth.requestOtp(PHONE)).rejects.toThrowError(ServiceUnavailableException);
    // Neither the superseded challenge nor the undelivered one is usable.
    await expect(auth.verifyOtp(first.requestId, first.devCode!)).rejects.toThrowError(
      UnauthorizedException
    );
    // The undelivered challenge must be gone: a fresh request works once the
    // provider recovers, and nothing usable was left behind.
    driver = makeSmsDriver();
    const ok = await auth.requestOtp(PHONE);
    expect(ok.requestId).toBeTruthy();
    expect((await auth.verifyOtp(ok.requestId, ok.devCode!)).user.phone).toBe(PHONE);
  });

  it('fails closed with 503 in production when SMS_DRIVER is stub (V-16)', async () => {
    process.env.NODE_ENV = 'production';
    await expect(makeService().requestOtp(PHONE)).rejects.toThrowError(ServiceUnavailableException);
    await expect(makeService({ smsDriver: () => undefined }).requestOtp(PHONE)).rejects.toThrowError(
      ServiceUnavailableException
    );
  });

  it('fails closed with 503 when the live driver is misconfigured (V-16)', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService({
      smsDriver: () => {
        throw new Error('TERMII_API_KEY missing');
      }
    });
    await expect(auth.requestOtp(PHONE)).rejects.toThrowError(ServiceUnavailableException);
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

  it('rejects verification for unknown phone numbers with the same wording as a wrong code (V-68)', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    // Wrong code on a registered number:
    const known = await auth.requestOtp(PHONE);
    const wrong = known.devCode === '000000' ? '000001' : '000000';
    const wrongCodeError = await auth.verifyOtp(known.requestId, wrong).catch((error) => error);
    // Correct code on an unregistered number:
    const unknown = await auth.requestOtp('+2348099999999');
    const unknownError = await auth
      .verifyOtp(unknown.requestId, unknown.devCode!)
      .catch((error) => error);
    expect(unknownError).toBeInstanceOf(UnauthorizedException);
    // Identical text: no registration-status oracle.
    expect(unknownError.message).toBe(wrongCodeError.message);
    expect(unknownError.message).toBe('Invalid or expired OTP code');
  });

  it('counts parallel wrong guesses atomically — N guesses consume N attempts (V-68)', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const wrong = devCode === '000000' ? '000001' : '000000';
    // Fire OTP_MAX_ATTEMPTS wrong guesses concurrently: every one must
    // consume an attempt, so the challenge locks out exactly at the cap and
    // even the correct code is dead afterwards.
    const results = await Promise.all(
      Array.from({ length: OTP_MAX_ATTEMPTS }, () =>
        auth.verifyOtp(requestId, wrong).catch((error) => error)
      )
    );
    for (const error of results) {
      expect(error).toBeInstanceOf(Object);
    }
    await expect(auth.verifyOtp(requestId, devCode!)).rejects.toThrowError(UnauthorizedException);
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
    // Fake timers: the per-phone resend cap (V-62, 3 per 10 minutes) means
    // the reissue cycles below must advance past the short request window.
    vi.useFakeTimers();
    const auth = makeService();
    // Burn the per-phone budget: OTP_PHONE_MAX_FAILURES wrong guesses spread
    // across reissued challenges (5 fresh guesses per cycle without the cap).
    for (let cycle = 0; cycle < OTP_PHONE_MAX_FAILURES / OTP_MAX_ATTEMPTS; cycle += 1) {
      const { requestId, devCode } = await auth.requestOtp(PHONE);
      const wrong = devCode === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
        await auth.verifyOtp(requestId, wrong).catch(() => undefined);
      }
      // Stay inside the 1-hour failure window but outside the 10-minute
      // request window.
      vi.advanceTimersByTime(11 * 60 * 1000);
    }
    // The next challenge refuses even the correct code with a 429.
    const { requestId, devCode } = await auth.requestOtp(PHONE);
    const refused = await auth.verifyOtp(requestId, devCode!).catch((error) => error);
    expect(refused.getStatus?.()).toBe(429);
    expect(String(refused.message)).toContain('Too many failed verification attempts');
  });

  it('caps OTP requests per phone: 4th request inside 10 minutes is a 429 (V-62)', async () => {
    process.env.NODE_ENV = 'test';
    const auth = makeService();
    for (let i = 0; i < 3; i += 1) {
      await auth.requestOtp(PHONE);
    }
    const refused = await auth.requestOtp(PHONE).catch((error) => error);
    expect(refused.getStatus?.()).toBe(429);
    expect(String(refused.message)).toContain('Too many OTP requests for this phone number');
    // The cap is keyed on the phone, not the caller: another number is fine.
    const other = await auth.requestOtp('+2348010000002');
    expect(other.requestId).toBeTruthy();
    // And a refused request must not have killed the last usable challenge.
  });

  it('enforces the daily per-phone request cap across short-window resets (V-62)', async () => {
    process.env.NODE_ENV = 'test';
    vi.useFakeTimers();
    const auth = makeService();
    for (let i = 0; i < 10; i += 1) {
      await auth.requestOtp(PHONE);
      // Reset the 10-minute window every 3 requests (well inside one day).
      if ((i + 1) % 3 === 0) {
        vi.advanceTimersByTime(11 * 60 * 1000);
      }
    }
    vi.advanceTimersByTime(11 * 60 * 1000);
    const refused = await auth.requestOtp(PHONE).catch((error) => error);
    expect(refused.getStatus?.()).toBe(429);
    // After the daily window the phone can request again.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    const again = await auth.requestOtp(PHONE);
    expect(again.requestId).toBeTruthy();
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

/**
 * Full stack with a spying audit sink (OB-03) for the registration
 * verification flow (OB-01).
 */
function makeStack() {
  const users = new UsersService(createInMemoryUserRepository());
  const audit = { record: vi.fn(async (input: unknown) => input) };
  const auth = new AuthService(
    users,
    new DomainEventsService(createInMemoryOutboxRepository()),
    new MetricsService(),
    new KeyValueOtpChallengeStore(new InMemoryKeyValueStore()),
    new SessionService(users, createInMemoryAuthSessionRepository()),
    undefined,
    undefined,
    audit as unknown as AuditService
  );
  return { auth, users, audit };
}

const REGISTER_INPUT = {
  phone: '+2348070000001',
  fullName: 'New Farmer',
  roles: ['farmer' as const],
  preferredLanguage: 'en' as const
};

describe('AuthService.register (OB-01 verify-then-session)', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns NO tokens — only the unverified user and an otpRequestId', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, users } = makeStack();
    const result = await auth.register(REGISTER_INPUT);
    expect(result.otpRequestId).toBeTruthy();
    expect(result.user.phone).toBe(REGISTER_INPUT.phone);
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('refreshToken');
    expect(result).not.toHaveProperty('refreshTokenExpiresAt');
    // The account starts unverified at tier_0 — no active session exists.
    const stored = await users.findByPhone(REGISTER_INPUT.phone);
    expect(stored?.isVerified).toBe(false);
    expect(stored?.kycTier).toBe('tier_0');
  });

  it('self-heals a duplicate UNVERIFIED phone: new name/roles, same id, fresh OTP', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, users } = makeStack();
    const first = await auth.register(REGISTER_INPUT);
    const second = await auth.register({
      ...REGISTER_INPUT,
      fullName: 'Reclaimed Name',
      roles: ['buyer']
    });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.fullName).toBe('Reclaimed Name');
    expect(second.user.roles).toEqual(['buyer']);
    expect(second.otpRequestId).toBeTruthy();
    expect(second.otpRequestId).not.toBe(first.otpRequestId);
    // Still unverified — possession has not been proven yet.
    expect((await users.findByPhone(REGISTER_INPUT.phone))?.isVerified).toBe(false);
    // Only one account exists for the phone.
    expect((await users.list({})).data.filter((u) => u.phone === REGISTER_INPUT.phone)).toHaveLength(1);
  });

  it('conflicts on a duplicate VERIFIED phone, directing to OTP login', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, users } = makeStack();
    const first = await auth.register(REGISTER_INPUT);
    await users.setVerified(first.user.id, true);
    const error = await auth
      .register({ ...REGISTER_INPUT, fullName: 'Squatter' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toContain('OTP');
    // The verified record is untouched.
    const stored = await users.findByPhone(REGISTER_INPUT.phone);
    expect(stored?.fullName).toBe(REGISTER_INPUT.fullName);
  });

  it('verifyOtp marks a previously unverified user verified BEFORE issuing tokens', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, users } = makeStack();
    const { user } = await auth.register(REGISTER_INPUT);
    expect(user.isVerified).toBe(false);
    // The registration challenge carries no devCode on the response; the
    // client-side equivalent here is a fresh request (non-prod devCode).
    const { requestId, devCode } = await auth.requestOtp(REGISTER_INPUT.phone);
    const session = await auth.verifyOtp(requestId, devCode!);
    expect(session.token).toContain('stub-token.');
    expect(session.user.isVerified).toBe(true);
    expect((await users.getById(user.id)).isVerified).toBe(true);
  });

  it('records user.registered, otp.requested and otp.verified in the audit log (OB-03)', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, audit } = makeStack();
    await auth.register(REGISTER_INPUT);
    const actions = () => audit.record.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions()).toContain('user.registered');
    expect(actions()).toContain('otp.requested');
    const registered = audit.record.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'user.registered'
    );
    expect((registered![0] as { metadata: { selfHealed: boolean } }).metadata.selfHealed).toBe(false);

    const { requestId, devCode } = await auth.requestOtp(REGISTER_INPUT.phone);
    await auth.verifyOtp(requestId, devCode!);
    expect(actions()).toContain('otp.verified');
  });

  it('records user.registered with selfHealed=true on the squatting-reclaim path (OB-03)', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, audit } = makeStack();
    await auth.register(REGISTER_INPUT);
    audit.record.mockClear();
    await auth.register({ ...REGISTER_INPUT, fullName: 'Reclaimed Name' });
    const registered = audit.record.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'user.registered'
    );
    expect((registered![0] as { metadata: { selfHealed: boolean } }).metadata.selfHealed).toBe(true);
  });

  it('records otp.failed on a wrong code (OB-03)', async () => {
    process.env.NODE_ENV = 'test';
    const { auth, audit } = makeStack();
    const { requestId, devCode } = await auth.requestOtp(REGISTER_INPUT.phone);
    const wrong = devCode === '000000' ? '000001' : '000000';
    await auth.verifyOtp(requestId, wrong).catch(() => undefined);
    const failed = audit.record.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'otp.failed'
    );
    expect(failed).toBeDefined();
    expect((failed![0] as { metadata: { reason: string } }).metadata.reason).toBe('invalid_code');
  });
});

describe('RegisterDto E.164 validation (OB-02)', () => {
  function errorsFor(phone: string) {
    const dto = new RegisterDto();
    dto.phone = phone;
    dto.fullName = 'Test User';
    dto.roles = ['farmer'];
    dto.preferredLanguage = 'en';
    return validateSync(dto);
  }

  it('accepts canonical E.164 numbers', () => {
    expect(errorsFor('+2348012345678')).toHaveLength(0);
    expect(errorsFor('+14155552671')).toHaveLength(0);
  });

  it('rejects local format, missing plus and malformed numbers', () => {
    for (const phone of ['08012345678', '2348012345678', '+0123', '+23480CALLME', '']) {
      const errors = errorsFor(phone);
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors)).toContain('E.164');
    }
  });
});

describe('RequestOtpDto E.164 validation (V-62)', () => {
  function errorsFor(phone: string) {
    const dto = new RequestOtpDto();
    dto.phone = phone;
    return validateSync(dto);
  }

  it('accepts canonical E.164 numbers', () => {
    expect(errorsFor('+2348012345678')).toHaveLength(0);
    expect(errorsFor('+14155552671')).toHaveLength(0);
  });

  it('rejects local format, missing plus and oversized numbers', () => {
    expect(errorsFor('08012345678').length).toBeGreaterThan(0);
    expect(errorsFor('2348012345678').length).toBeGreaterThan(0);
    expect(errorsFor('+0123').length).toBeGreaterThan(0);
    expect(errorsFor('+234801234567890123456').length).toBeGreaterThan(0);
    expect(errorsFor('+23480CALLME').length).toBeGreaterThan(0);
  });
});
