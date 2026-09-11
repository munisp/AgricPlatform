import { NotFoundException } from '@nestjs/common';

/**
 * Shared-device PIN profiles (USSD wave P5b, growth-model shared-phone gap):
 * up to five farmer profiles per feature phone, each with a salted 4-digit
 * PIN. Fail-closed: 5 wrong attempts lock the profile for 15 minutes (OTP
 * policy parity); attempt increments are ATOMIC per row (audit C2-5).
 * In-memory is the default driver; pg implementation lives in
 * pin-profile.pg-repository.ts and is selected by DatabaseModule when PG_POOL
 * is configured.
 */

export const MAX_PROFILES_PER_DEVICE = 5;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

export interface PinProfile {
  deviceToken: string;
  userId: string;
  /** Salted hash: sha256(`pin:${deviceToken}:${userId}:${pin}`). */
  pinHash: string;
  attempts: number;
  lockedUntil?: string;
  createdAt: string;
}

export interface PinProfilePatch {
  attempts?: number;
  lockedUntil?: string;
}

export interface PinProfileRepository {
  find(deviceToken: string, userId: string): Promise<PinProfile | undefined>;
  listForDevice(deviceToken: string): Promise<PinProfile[]>;
  /**
   * All profiles belonging to one user across devices (Stage 27 Voice
   * Teller): the IVR channel authenticates the CALLER, not a specific
   * device, so PIN verification checks the user's shared-device PINs.
   */
  listForUser(userId: string): Promise<PinProfile[]>;
  save(profile: PinProfile): Promise<PinProfile>;
  update(deviceToken: string, userId: string, patch: PinProfilePatch): Promise<PinProfile>;
  /**
   * Atomically increments the failed-attempt counter and returns the new
   * count (audit C2-5: read-modify-write races would let an attacker retry
   * PINs beyond the 5-attempt ceiling).
   */
  incrementAttempts(deviceToken: string, userId: string): Promise<number>;
  countForDevice(deviceToken: string): Promise<number>;
}

export class InMemoryPinProfileRepository implements PinProfileRepository {
  private readonly items = new Map<string, PinProfile>();

  private key(deviceToken: string, userId: string): string {
    return `${deviceToken}:${userId}`;
  }

  async find(deviceToken: string, userId: string): Promise<PinProfile | undefined> {
    const found = this.items.get(this.key(deviceToken, userId));
    return found ? { ...found } : undefined;
  }

  async listForDevice(deviceToken: string): Promise<PinProfile[]> {
    return [...this.items.values()]
      .filter((profile) => profile.deviceToken === deviceToken)
      .map((profile) => ({ ...profile }));
  }

  async listForUser(userId: string): Promise<PinProfile[]> {
    return [...this.items.values()]
      .filter((profile) => profile.userId === userId)
      .map((profile) => ({ ...profile }));
  }

  async save(profile: PinProfile): Promise<PinProfile> {
    this.items.set(this.key(profile.deviceToken, profile.userId), { ...profile });
    return { ...profile };
  }

  async update(deviceToken: string, userId: string, patch: PinProfilePatch): Promise<PinProfile> {
    const existing = this.items.get(this.key(deviceToken, userId));
    if (!existing) {
      throw new NotFoundException(`PIN profile ${userId} on ${deviceToken} not found`);
    }
    const updated: PinProfile = {
      ...existing,
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.lockedUntil !== undefined ? { lockedUntil: patch.lockedUntil } : {})
    };
    this.items.set(this.key(deviceToken, userId), updated);
    return { ...updated };
  }

  async incrementAttempts(deviceToken: string, userId: string): Promise<number> {
    const existing = this.items.get(this.key(deviceToken, userId));
    if (!existing) {
      throw new NotFoundException(`PIN profile ${userId} on ${deviceToken} not found`);
    }
    existing.attempts += 1;
    return existing.attempts;
  }

  async countForDevice(deviceToken: string): Promise<number> {
    return (await this.listForDevice(deviceToken)).length;
  }
}

export function createInMemoryPinProfileRepository(): InMemoryPinProfileRepository {
  return new InMemoryPinProfileRepository();
}
