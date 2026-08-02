import { createHash, randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import { newId } from '../../common/async-repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { OTP_STORE } from '../../database/persistence.tokens.js';
import type { OtpChallengeStore } from '../../redis/otp-challenge.store.js';
import { UsersService, type CreateUserInput } from '../users/users.service.js';

const OTP_TTL_MS = 5 * 60 * 1000;
/** Per-challenge verification attempts before the challenge is locked out. */
export const OTP_MAX_ATTEMPTS = 5;

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
 * new code invalidates outstanding challenges for the same phone number.
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
    @Inject(OTP_STORE) private readonly otp: OtpChallengeStore
  ) {}

  async requestOtp(phone: string): Promise<OtpRequestResult> {
    // Invalidate outstanding challenges for this phone so only the newest
    // code is usable (limits parallel guessing windows).
    await this.otp.invalidateForPhone(phone);
    // Stub driver: the code is returned for local development only. The
    // production Termii SMS adapter delivers it out-of-band instead.
    const code = randomInt(100000, 999999).toString();
    const challenge = {
      id: newId('otp'),
      phone,
      codeHash: this.hash(code),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0
    };
    await this.otp.save(challenge, OTP_TTL_MS);
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

  async verifyOtp(requestId: string, code: string): Promise<{ token: string; user: User }> {
    const challenge = await this.otp.get(requestId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      await this.otp.delete(requestId);
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await this.otp.delete(requestId);
      throw new HttpException(
        'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (challenge.codeHash !== this.hash(code)) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        await this.otp.delete(requestId);
        throw new HttpException(
          'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      await this.otp.save(challenge, challenge.expiresAt - Date.now());
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    // Atomic single-use consumption: concurrent verifications of the same
    // code cannot both succeed.
    const consumed = await this.otp.consume(requestId);
    if (!consumed) {
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    const user = await this.users.findByPhone(consumed.phone);
    if (!user) {
      throw new UnauthorizedException('No account for this phone number. Register first.');
    }
    return { token: this.issueStubToken(user), user };
  }

  async register(input: CreateUserInput): Promise<{ token: string; user: User }> {
    const user = await this.users.create(input);
    await this.events.publish('identity.user.registered', { userId: user.id, roles: user.roles }, user.id);
    return { token: this.issueStubToken(user), user };
  }

  async session(userId: string): Promise<{ user: User }> {
    return { user: await this.users.getById(userId) };
  }

  private issueStubToken(user: User): string {
    // Not a real JWT. Keycloak-issued tokens replace this in production.
    return `stub-token.${Buffer.from(user.id).toString('base64url')}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
