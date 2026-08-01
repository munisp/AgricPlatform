import { createHash, randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import { newId } from '../../common/in-memory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { UsersService, type CreateUserInput } from '../users/users.service.js';

interface OtpChallenge {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

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
 */
@Injectable()
export class AuthService {
  private readonly challenges = new Map<string, OtpChallenge>();

  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService
  ) {}

  requestOtp(phone: string): OtpRequestResult {
    // Invalidate outstanding challenges for this phone so only the newest
    // code is usable (limits parallel guessing windows).
    for (const [id, challenge] of this.challenges) {
      if (challenge.phone === phone) {
        this.challenges.delete(id);
      }
    }
    // Stub driver: the code is returned for local development only. The
    // production Termii SMS adapter delivers it out-of-band instead.
    const code = randomInt(100000, 999999).toString();
    const challenge: OtpChallenge = {
      id: newId('otp'),
      phone,
      codeHash: this.hash(code),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0
    };
    this.challenges.set(challenge.id, challenge);
    this.events.publish('identity.otp.requested', { phone, requestId: challenge.id });
    const result: OtpRequestResult = {
      requestId: challenge.id,
      expiresInSeconds: OTP_TTL_MS / 1000
    };
    if (!isProduction()) {
      result.devCode = code;
    }
    return result;
  }

  verifyOtp(requestId: string, code: string): { token: string; user: User } {
    const challenge = this.challenges.get(requestId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      this.challenges.delete(requestId);
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      this.challenges.delete(requestId);
      throw new HttpException(
        'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (challenge.codeHash !== this.hash(code)) {
      challenge.attempts += 1;
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        this.challenges.delete(requestId);
        throw new HttpException(
          'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    this.challenges.delete(requestId);
    const user = this.users.findByPhone(challenge.phone);
    if (!user) {
      throw new UnauthorizedException('No account for this phone number. Register first.');
    }
    return { token: this.issueStubToken(user), user };
  }

  register(input: CreateUserInput): { token: string; user: User } {
    const user = this.users.create(input);
    this.events.publish('identity.user.registered', { userId: user.id, roles: user.roles }, user.id);
    return { token: this.issueStubToken(user), user };
  }

  session(userId: string): { user: User } {
    return { user: this.users.getById(userId) };
  }

  private issueStubToken(user: User): string {
    // Not a real JWT. Keycloak-issued tokens replace this in production.
    return `stub-token.${Buffer.from(user.id).toString('base64url')}`;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
