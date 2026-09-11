import { createHash, randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import { newId } from '../../common/async-repository.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { OTP_STORE } from '../../database/persistence.tokens.js';
import type { OtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { UsersService, type CreateUserInput } from '../users/users.service.js';
import { SessionService } from './session.service.js';

const OTP_TTL_MS = 5 * 60 * 1000;
/** Per-challenge verification attempts before the challenge is locked out. */
export const OTP_MAX_ATTEMPTS = 5;
/**
 * Per-phone rolling cap on failed verifications (audit C3): reissuing a
 * challenge must not hand out 5 fresh guesses per cycle. Beyond this many
 * failed verifications in the window the phone is refused with 429.
 */
export const OTP_PHONE_MAX_FAILURES = 20;
export const OTP_PHONE_FAILURE_WINDOW_MS = 60 * 60 * 1000;

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
  /** Development stub only — never present in production. */
  devCode?: string;
}

/**
 * OTP-ready auth contracts. Phase 1 issues stub sessions; production swaps
 * token issuance for Keycloak OIDC while keeping these request/response
 * shapes stable for clients.
 *
 * Hardening (docs/security-compliance.md §7 "Auth failures"): the dev code
 * is only returned outside production; challenges expire, track failed
 * attempts, and lock out after OTP_MAX_ATTEMPTS wrong codes; requesting a
 * new code invalidates outstanding challenges for the same phone number; and
 * a per-phone rolling cap (OTP_PHONE_MAX_FAILURES per hour, audit C3)
 * refuses phones that keep failing across reissued challenges.
 *
 * Challenges live in the injected OTP store (Redis in production, in-memory
 * otherwise); successful verification consumes the challenge atomically
 * (single-use across replicas).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    private readonly metrics: MetricsService,
    @Inject(OTP_STORE) private readonly otp: OtpChallengeStore,
    private readonly sessions: SessionService
  ) {}

  async requestOtp(phone: string): Promise<OtpRequestResult> {
    // Invalidate outstanding challenges for this phone so only the newest
    // code is usable (limits parallel guessing windows).
    await this.otp.invalidateForPhone(phone);
    // Stub driver: the code is returned for local development only. The
    // production Termii SMS adapter delivers it out-of-band instead. Full
    // 6-digit space including leading zeros (audit C3): the randomInt upper
    // bound is exclusive, so [0, 1_000_000) zero-padded covers 000000-999999.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challenge = {
      id: newId('otp'),
      phone,
      codeHash: this.hash(code),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0
    };
    await this.otp.save(challenge, OTP_TTL_MS);
    // Phase 1 delivers via SMS (Termii); the channel label stays low-cardinality.
    this.metrics.otpRequested('sms');
    await this.events.publish('identity.otp.requested', { phone, requestId: challenge.id });
    const result: OtpRequestResult = {
      requestId: challenge.id,
      expiresInSeconds: OTP_TTL_MS / 1000
    };
    if (!isProduction()) {
      result.devCode = code;
    }
    return result;
  }

  async verifyOtp(
    requestId: string,
    code: string,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    const challenge = await this.otp.get(requestId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      await this.otp.delete(requestId);
      this.metrics.otpVerification('invalid');
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await this.otp.delete(requestId);
      this.metrics.otpVerification('locked');
      throw new HttpException(
        'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    // Per-phone rolling cap (audit C3): survives challenge reissue, so
    // cycling /otp/request cannot reset the guessing budget.
    const phoneFailures = await this.otp.phoneFailureCount(challenge.phone);
    if (phoneFailures >= OTP_PHONE_MAX_FAILURES) {
      this.metrics.otpVerification('locked');
      throw new HttpException(
        'Too many failed verification attempts for this phone number. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (challenge.codeHash !== this.hash(code)) {
      challenge.attempts += 1;
      await this.otp.registerPhoneFailure(challenge.phone, OTP_PHONE_FAILURE_WINDOW_MS);
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        await this.otp.delete(requestId);
        this.metrics.otpVerification('locked');
        throw new HttpException(
          'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      await this.otp.save(challenge, challenge.expiresAt - Date.now());
      this.metrics.otpVerification('invalid');
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    // Atomic single-use consumption: concurrent verifications of the same
    // code cannot both succeed.
    const consumed = await this.otp.consume(requestId);
    if (!consumed) {
      this.metrics.otpVerification('invalid');
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    const user = await this.users.findByPhone(consumed.phone);
    if (!user) {
      this.metrics.otpVerification('invalid');
      throw new UnauthorizedException('No account for this phone number. Register first.');
    }
    this.metrics.otpVerification('success');
    return this.withRefreshToken(user, meta);
  }

  async register(
    input: CreateUserInput,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    const user = await this.users.create(input);
    await this.events.publish('identity.user.registered', { userId: user.id, roles: user.roles }, user.id);
    return this.withRefreshToken(user, meta);
  }

  async session(userId: string): Promise<{ user: User }> {
    return { user: await this.users.getById(userId) };
  }

  /**
   * Issues a session for an identity already verified by another factor
   * (wave P5b shared-device PIN swap). Same stub-token contract as OTP.
   */
  async issueSessionFor(
    userId: string,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    const user = await this.users.getById(userId);
    return this.withRefreshToken(user, meta);
  }

  /** Access token plus a rotated refresh-token session (Wave P). */
  private async withRefreshToken(
    user: User,
    meta?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    const session = await this.sessions.issue(user.id, meta ?? {});
    return {
      token: this.issueStubToken(user),
      user,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt
    };
  }

  private issueStubToken(user: User): string {
    // Not a real JWT. Keycloak-issued tokens replace this in production.
    return `stub-token.${Buffer.from(user.id).toString('base64url')}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
