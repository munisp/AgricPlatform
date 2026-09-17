import { createHash, randomInt } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { isProduction } from '../../common/auth/auth.config.js';
import { newId } from '../../common/async-repository.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { OTP_STORE } from '../../database/persistence.tokens.js';
import type { OtpChallengeStore } from '../../redis/otp-challenge.store.js';
import type { SmsDriver } from '../integrations/drivers/sms.drivers.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import { UsersService, type CreateUserInput } from '../users/users.service.js';
import { AUTH_UNAVAILABLE, KeycloakPhoneTokenService } from './keycloak-phone-token.service.js';
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
/**
 * Per-phone OTP request caps (V-62): the per-IP throttle cannot stop an
 * attacker rotating source IPs from SMS-bombing one victim (toll fraud).
 * Requests are counted per phone in a 10-minute and a daily fixed window;
 * beyond either cap the request is refused with 429 before any SMS is sent.
 */
export const OTP_PHONE_MAX_REQUESTS_SHORT = 3;
export const OTP_PHONE_REQUEST_SHORT_WINDOW_MS = 10 * 60 * 1000;
export const OTP_PHONE_MAX_REQUESTS_DAILY = 10;
export const OTP_PHONE_REQUEST_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    private readonly sessions: SessionService,
    /**
     * WP-G16 flagged Keycloak token issuer. Optional so legacy plain
     * constructions (unit tests) keep working: when absent a fresh instance
     * is resolved from the environment at issuance time.
     */
    @Optional() private readonly phoneTokens?: KeycloakPhoneTokenService,
    /**
     * OTP delivery (V-16): supplies the live SMS driver. Optional so bare
     * unit-test constructions keep working — an absent integrations service
     * behaves like the stub driver (devCode outside production, fail-closed
     * 503 in production).
     */
    @Optional() private readonly integrations?: IntegrationsService
  ) {}

  async requestOtp(phone: string): Promise<OtpRequestResult> {
    // Per-phone resend caps (V-62), checked BEFORE any state change: a
    // refused request must not invalidate the caller's still-usable
    // challenge, and the atomic increment-first ordering means capped
    // requests still burn budget instead of racing the check.
    const [shortCount, dailyCount] = await Promise.all([
      this.otp.registerPhoneRequest(phone, OTP_PHONE_REQUEST_SHORT_WINDOW_MS),
      this.otp.registerPhoneRequest(phone, OTP_PHONE_REQUEST_DAILY_WINDOW_MS)
    ]);
    if (shortCount > OTP_PHONE_MAX_REQUESTS_SHORT || dailyCount > OTP_PHONE_MAX_REQUESTS_DAILY) {
      throw new HttpException(
        'Too many OTP requests for this phone number. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
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
    try {
      await this.deliverCode(phone, code);
    } catch (error) {
      // Fail closed (V-16): an undelivered code must leave no usable
      // challenge behind — a stuck challenge would only hand attackers a
      // guessing window on a code the user never received.
      await this.otp.invalidateForPhone(phone);
      throw error;
    }
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
    if ((await this.otp.attemptCount(requestId)) >= OTP_MAX_ATTEMPTS) {
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
      // Atomic attempt accounting (V-68): the counter is incremented in the
      // store, so parallel wrong guesses each consume an attempt — the old
      // read-modify-write on the challenge JSON let concurrent guesses race
      // and spend fewer attempts than they made.
      const attempts = await this.otp.registerAttempt(
        requestId,
        challenge.expiresAt - Date.now()
      );
      await this.otp.registerPhoneFailure(challenge.phone, OTP_PHONE_FAILURE_WINDOW_MS);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await this.otp.delete(requestId);
        this.metrics.otpVerification('locked');
        throw new HttpException(
          'Too many incorrect attempts; this OTP challenge is locked. Request a new code.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
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
      // Uniform error wording (V-68): a distinct "no account" message after a
      // correct code would confirm the number is unregistered — an
      // enumeration oracle. Unknown numbers and wrong codes answer alike.
      this.metrics.otpVerification('invalid');
      throw new UnauthorizedException('Invalid or expired OTP code');
    }
    this.metrics.otpVerification('success');
    // Credential threading: the just-consumed OTP code is the verified
    // second factor; the flagged Keycloak issuer exchanges it (flag off →
    // the credential is ignored and the dev/test stub path decides).
    return this.withRefreshToken(user, meta, code);
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
   * (wave P5b shared-device PIN swap). Same token contract as OTP. The
   * optional credential is the verified second factor (PIN) forwarded to
   * Keycloak when PHONE_AUTH_KEYCLOAK is on; without one the Keycloak path
   * fails closed with 503 AUTH_UNAVAILABLE.
   */
  async issueSessionFor(
    userId: string,
    meta?: { userAgent?: string; ipAddress?: string },
    credential?: string
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    const user = await this.users.getById(userId);
    return this.withRefreshToken(user, meta, credential);
  }

  /** Access token plus a rotated refresh-token session (Wave P). */
  private async withRefreshToken(
    user: User,
    meta?: { userAgent?: string; ipAddress?: string },
    credential?: string
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    // Mint the access token FIRST: when issuance fails closed (production
    // guard / Keycloak outage) no orphaned refresh session is persisted.
    const token = await this.issueAccessToken(user, credential);
    const session = await this.sessions.issue(user.id, meta ?? {});
    return {
      token,
      user,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt
    };
  }

  /**
   * Access-token issuance (WP-G16). PHONE_AUTH_KEYCLOAK=true routes through
   * the Keycloak token endpoint; with the flag off the stub remains for
   * dev/test ONLY — production fails closed with 503 AUTH_UNAVAILABLE and
   * the stub path can NEVER issue a token there.
   */
  private issueAccessToken(user: User, credential?: string): Promise<string> {
    const tokens = this.phoneTokens ?? new KeycloakPhoneTokenService();
    if (tokens.enabled) {
      return tokens.issueToken(user, credential);
    }
    if (isProduction()) {
      return Promise.reject(
        new ServiceUnavailableException(
          `${AUTH_UNAVAILABLE}: phone-auth token issuance is disabled (PHONE_AUTH_KEYCLOAK is not ` +
            'true) and the development stub token is forbidden in production. Configure Keycloak ' +
            'token issuance or phone login stays closed.'
        )
      );
    }
    // Explicit non-production assertion: the stub token exists only here.
    return Promise.resolve(this.issueStubToken(user));
  }

  private issueStubToken(user: User): string {
    // Not a real JWT. Dev/test only — issueAccessToken refuses this path in
    // production, and PHONE_AUTH_KEYCLOAK=true replaces it with Keycloak.
    return `stub-token.${Buffer.from(user.id).toString('base64url')}`;
  }

  /**
   * OTP delivery (V-16). With a live SMS driver the code goes out over the
   * provider's OTP endpoint; any provider failure is a 503 (fail closed —
   * never silently succeed). The stub driver sends nothing: outside
   * production the devCode path covers local development, while production
   * without live delivery is a hard 503 so phone login fails closed instead
   * of issuing undeliverable codes (activation: E-03).
   */
  private async deliverCode(phone: string, code: string): Promise<void> {
    let driver: SmsDriver | undefined;
    try {
      driver = this.integrations?.smsDriver();
    } catch (error) {
      // Enabled-but-misconfigured live driver (non-production lazy build):
      // fail closed with 503 rather than an unmapped 500.
      throw new ServiceUnavailableException(
        `OTP delivery is unavailable: ${error instanceof Error ? error.message : 'SMS driver error'}`
      );
    }
    if (!driver) {
      if (isProduction()) {
        throw new ServiceUnavailableException(
          'OTP delivery is unavailable: SMS_DRIVER is stub, so no code can be delivered. ' +
            'Configure a live SMS driver (Termii/Twilio credentials) to open phone login.'
        );
      }
      return;
    }
    try {
      const result = await driver.sendOtp(phone, code);
      if (!result.delivered) {
        throw new Error(`provider ${result.provider} reported the message as not delivered`);
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      throw new ServiceUnavailableException(
        `OTP delivery failed: ${error instanceof Error ? error.message : 'SMS provider error'}`
      );
    }
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
