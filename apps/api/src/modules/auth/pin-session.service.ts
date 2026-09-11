import { createHash } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
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

const PIN_PATTERN = /^\d{4}$/;

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
    return createHash('sha256').update(`pin:${deviceToken}:${userId}:${pin}`).digest('hex');
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

  /** Lists the profiles on a device (no hashes). */
  async listProfiles(deviceToken: string): Promise<Array<{ userId: string; createdAt: string }>> {
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
  ): Promise<{ token: string; user: User }> {
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
    return this.auth.issueSessionFor(userId);
  }
}
