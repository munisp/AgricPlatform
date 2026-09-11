import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PIN_PROFILE_REPOSITORY } from '../../database/persistence.tokens.js';
import {
  MAX_PROFILES_PER_DEVICE,
  PIN_LOCKOUT_MS,
  PIN_MAX_ATTEMPTS,
  type PinProfileRepository
} from '../../database/repositories/pin-profile.repository.js';

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

/** Session token TTL after a successful PIN login (long market days). */
export const PIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface PinSession {
  token: string;
  deviceToken: string;
  userId: string;
  expiresAt: string;
}

export class PinError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PIN_FORMAT'
      | 'PROFILE_LIMIT'
      | 'UNKNOWN_PROFILE'
      | 'LOCKED'
      | 'WRONG_PIN'
      | 'SESSION_EXPIRED',
    message: string
  ) {
    super(message);
    this.name = 'PinError';
  }
}

/**
 * Shared-device PIN auth (USSD wave P5b): enrolment and verification for
 * family phones carrying up to 5 farmer profiles. Sessions are in-memory
 * tokens (TTL 12 h); PINs are salted per (device, user) and never logged.
 * Fail-closed lockout: 5 wrong attempts → 15-minute lock (same policy as
 * the OTP service; atomic attempt increments per audit C2-5).
 */
@Injectable()
export class PinSessionService {
  private readonly sessions = new Map<string, PinSession>();

  constructor(
    @Inject(PIN_PROFILE_REPOSITORY) private readonly profiles: PinProfileRepository,
    @Optional() private readonly now: () => number = Date.now
  ) {}

  /** Registers (or replaces) a farmer's PIN on a shared device. */
  async addProfile(deviceToken: string, userId: string, pin: string) {
    if (!PIN_PATTERN.test(pin)) {
      throw new PinError('INVALID_PIN_FORMAT', 'PIN must be exactly 4 digits');
    }
    const existing = await this.profiles.find(deviceToken, userId);
    if (!existing) {
      const count = await this.profiles.countForDevice(deviceToken);
      if (count >= MAX_PROFILES_PER_DEVICE) {
        throw new PinError(
          'PROFILE_LIMIT',
          `Device already has the maximum of ${MAX_PROFILES_PER_DEVICE} profiles`
        );
      }
    }
    return this.profiles.save({
      deviceToken,
      userId,
      pinHash: this.hashPin(deviceToken, userId, pin),
      attempts: 0,
      createdAt: existing?.createdAt ?? new Date(this.now()).toISOString()
    });
  }

  /** Verifies a PIN and mints a 12-hour session token. */
  async login(deviceToken: string, userId: string, pin: string): Promise<PinSession> {
    const profile = await this.profiles.find(deviceToken, userId);
    if (!profile) {
      throw new PinError('UNKNOWN_PROFILE', 'No profile for this user on this device');
    }
    if (profile.lockedUntil && new Date(profile.lockedUntil).getTime() > this.now()) {
      throw new PinError('LOCKED', 'Profile is locked; try again later');
    }
    if (profile.pinHash !== this.hashPin(deviceToken, userId, pin)) {
      // Atomic increment (audit C2-5) — no read-modify-write race window.
      const attempts = await this.profiles.incrementAttempts(deviceToken, userId);
      if (attempts >= PIN_MAX_ATTEMPTS) {
        await this.profiles.update(deviceToken, userId, {
          attempts: 0,
          lockedUntil: new Date(this.now() + PIN_LOCKOUT_MS).toISOString()
        });
        throw new PinError('LOCKED', 'Too many wrong PINs; profile locked for 15 minutes');
      }
      throw new PinError('WRONG_PIN', 'Wrong PIN');
    }
    if (profile.attempts > 0 || profile.lockedUntil) {
      await this.profiles.update(deviceToken, userId, { attempts: 0, lockedUntil: undefined });
    }
    const session: PinSession = {
      token: randomUUID(),
      deviceToken,
      userId,
      expiresAt: new Date(this.now() + PIN_SESSION_TTL_MS).toISOString()
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** Resolves a session token to its user; expired tokens fail closed. */
  resolve(token: string): PinSession {
    const session = this.sessions.get(token);
    if (!session || new Date(session.expiresAt).getTime() <= this.now()) {
      if (session) {
        this.sessions.delete(token);
      }
      throw new PinError('SESSION_EXPIRED', 'PIN session expired or unknown');
    }
    return session;
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  /** Salted PIN hash — the raw PIN never leaves the request. */
  hashPin(deviceToken: string, userId: string, pin: string): string {
    return hashSharedDevicePin(deviceToken, userId, pin);
  }
}
