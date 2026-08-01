import { createHash, randomInt } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/in-memory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { UsersService, type CreateUserInput } from '../users/users.service.js';

interface OtpChallenge {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: number;
}

const OTP_TTL_MS = 5 * 60 * 1000;

/**
 * OTP-ready auth contracts. Phase 1 issues stub sessions; production swaps
 * token issuance for Keycloak OIDC while keeping these request/response
 * shapes stable for clients.
 */
@Injectable()
export class AuthService {
  private readonly challenges = new Map<string, OtpChallenge>();

  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService
  ) {}

  requestOtp(phone: string): { requestId: string; expiresInSeconds: number; devCode: string } {
    // Stub driver: the code is returned for local development only. The
    // production Termii SMS adapter delivers it out-of-band instead.
    const code = randomInt(100000, 999999).toString();
    const challenge: OtpChallenge = {
      id: newId('otp'),
      phone,
      codeHash: this.hash(code),
      expiresAt: Date.now() + OTP_TTL_MS
    };
    this.challenges.set(challenge.id, challenge);
    this.events.publish('identity.otp.requested', { phone, requestId: challenge.id });
    return { requestId: challenge.id, expiresInSeconds: OTP_TTL_MS / 1000, devCode: code };
  }

  verifyOtp(requestId: string, code: string): { token: string; user: User } {
    const challenge = this.challenges.get(requestId);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.codeHash !== this.hash(code)) {
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
