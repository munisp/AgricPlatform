import { createHash } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { PIN_PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import type { PinProfile, PinProfileRepository } from '../../database/repositories/pin-profile.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

/** A shared Android device hosts at most this many family profiles. */
export const PIN_MAX_PROFILES_PER_DEVICE = 5;
/** Wrong-PIN attempts before the 15-minute lockout (mirrors OTP policy). */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Minimum device-token length accepted on the listing path (V-60): short,
 * client-chosen tokens are guessable, which made profile listing a
 * who-is-on-this-device enumeration oracle.
 */
export const PIN_MIN_DEVICE_TOKEN_LENGTH = 16;

// Character class (not a digit escape) keeps this source file free of literal backslashes.
const PIN_PATTERN = /^[0-9]{4}$/;

/**
 * Pure salted PIN hash (Stage 27 Voice Teller reuses this for IVR caller
 * verification so the formula can never drift between channels). The raw
 * PIN never leaves the request.
 */
export function hashSharedDevicePin(deviceToken: string, userId: string, pin: string): string {
  return createHash('sha256').update(`pin:${deviceToken}:${userId}:${pin}`).digest('hex');
}

export interface PinProfileView {
  deviceToken: string;
  userId: string;
  createdAt: string;
  profilesOnDevice: number;
}

/**
 * Shared-device PIN sessions (wave P5b): family members share one Android
 * device; each profile unlocks a fast session swap with a 4-digit PIN. PINs
 * are stored as salted hashes only, and the attempt/lockout policy reuses
 * the OTP challenge pattern (5 attempts → 15-minute lock).
 *
 * Credential threading (Stage-2 follow-up): after the PIN hash check passes,
 * the verified PIN is threaded into AuthService.issueSessionFor as the
 * second-factor credential. With PHONE_AUTH_KEYCLOAK on, that credential is
 * exchanged at the realm token endpoint; without a verified credential the
 * flagged path fails closed with 503 AUTH_UNAVAILABLE. The raw PIN is never
 * logged or persisted — only the salted hash below.
 */
@Injectable()
export class PinSessionService {
  constructor(
    @Inject(PIN_PROFILE_REPOSITORY) private readonly profiles: PinProfileRepository,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly events: DomainEventsService
  ) {}

  /** Salted PIN hash — the raw PIN never leaves the request. */
  hashPin(deviceToken: string, userId: string, pin: string): string {
    return hashSharedDevicePin(deviceToken, userId, pin);
  }

  /** Adds (or re-pins) the authenticated user's profile on a device. */
  async addProfile(userId: string, deviceToken: string, pin: string): Promise<PinProfileView> {
    if (!PIN_PATTERN.test(pin)) {
      throw new BadRequestException('PIN must be exactly 4 digits');
    }
    // Confirms the account exists before linking it to a device.
    await this.users.getById(userId);
    const existing = await this.profiles.find(deviceToken, userId);
    if (!existing) {
      const count = await this.profiles.countForDevice(deviceToken);
      if (count >= PIN_MAX_PROFILES_PER_DEVICE) {
        throw new BadRequestException(
          `This device already has the maximum of ${PIN_MAX_PROFILES_PER_DEVICE} profiles`
        );
      }
    }
    const profile: PinProfile = {
      deviceToken,
      userId,
      pinHash: this.hashPin(deviceToken, userId, pin),
      attempts: 0,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };
    await this.profiles.save(profile);
    await this.events.publish('identity.pin_profile.registered', { deviceToken }, userId);
    return {
      deviceToken,
      userId,
      createdAt: profile.createdAt,
      profilesOnDevice: await this.profiles.countForDevice(deviceToken)
    };
  }

  /**
   * Lists the profiles on a device (no hashes). Caller-bound (V-60): only a
   * caller who is themselves pinned on this device — or an admin — may list.
   * Weak (short, guessable) tokens and devices the caller is not pinned on
   * answer 404 alike, so the endpoint gives no token-existence signal.
   */
  async listProfiles(
    deviceToken: string,
    actor: User
  ): Promise<Array<{ userId: string; createdAt: string }>> {
    if (deviceToken.length < PIN_MIN_DEVICE_TOKEN_LENGTH) {
      throw new NotFoundException('Unknown device');
    }
    if (!actor.roles.includes('admin')) {
      const pinned = await this.profiles.find(deviceToken, actor.id);
      if (!pinned) {
        throw new NotFoundException('Unknown device');
      }
    }
    return (await this.profiles.listForDevice(deviceToken)).map((profile) => ({
      userId: profile.userId,
      createdAt: profile.createdAt
    }));
  }

  /**
   * Fast profile swap: verifies the PIN and issues a short-lived session for
   * the selected profile. Wrong PINs count towards the 5-attempt lockout;
   * locked profiles reject every attempt until the lock expires.
   */
  async switchProfile(
    deviceToken: string,
    userId: string,
    pin: string
  ): Promise<{ token: string; user: User; refreshToken: string; refreshTokenExpiresAt: string }> {
    if (!PIN_PATTERN.test(pin)) {
      throw new BadRequestException('PIN must be exactly 4 digits');
    }
    const profile = await this.profiles.find(deviceToken, userId);
    if (!profile) {
      throw new UnauthorizedException('Unknown device profile');
    }
    const now = Date.now();
    if (profile.lockedUntil && new Date(profile.lockedUntil).getTime() > now) {
      throw new HttpException(
        `Profile is locked after too many wrong PINs. Try again after ${profile.lockedUntil}.`,
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    if (profile.pinHash !== this.hashPin(deviceToken, userId, pin)) {
      // Atomic increment (audit C2-5): the repository counts this failed
      // attempt indivisibly, so concurrent wrong PINs cannot read the same
      // pre-increment counter and defeat the lockout.
      const attempts = await this.profiles.incrementAttempts(deviceToken, userId);
      if (attempts >= PIN_MAX_ATTEMPTS) {
        await this.profiles.update(deviceToken, userId, {
          attempts: 0,
          lockedUntil: new Date(now + PIN_LOCKOUT_MS).toISOString()
        });
        throw new HttpException(
          'Too many incorrect PINs; this profile is locked for 15 minutes.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
      throw new UnauthorizedException('Incorrect PIN');
    }
    if (profile.attempts > 0 || profile.lockedUntil) {
      await this.profiles.update(deviceToken, userId, { attempts: 0, lockedUntil: undefined });
    }
    // Credential threading: the PIN survived the salted-hash check, so it is
    // the verified second factor. It is threaded into token issuance — never
    // logged, never persisted (only its salted hash is stored above).
    return this.auth.issueSessionFor(userId, undefined, pin);
  }
}
