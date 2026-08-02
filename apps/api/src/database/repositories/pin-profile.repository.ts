/**
 * Shared-device PIN profile persistence port (wave P5b). Rows map to
 * channels.pin_profiles (infra/postgres/008_ussd_channels.sql). The composite
 * key (deviceToken, userId) enforces one profile per family member per
 * device; the service enforces the 5-profiles-per-device cap and the
 * attempt/lockout policy.
 */
export interface PinProfile {
  deviceToken: string;
  userId: string;
  /** Salted hash — the raw 4-digit PIN is never stored. */
  pinHash: string;
  /** Consecutive failed verification attempts since the last success/lock. */
  attempts: number;
  /** ISO-8601 lock expiry while attempt-limited; absent when not locked. */
  lockedUntil?: string;
  createdAt: string;
}

export interface PinProfileRepository {
  find(deviceToken: string, userId: string): Promise<PinProfile | undefined>;
  listForDevice(deviceToken: string): Promise<PinProfile[]>;
  countForDevice(deviceToken: string): Promise<number>;
  /** Upsert keyed on (deviceToken, userId). */
  save(profile: PinProfile): Promise<PinProfile>;
  update(
    deviceToken: string,
    userId: string,
    patch: Partial<Pick<PinProfile, 'pinHash' | 'attempts' | 'lockedUntil'>>
  ): Promise<PinProfile>;
  remove(deviceToken: string, userId: string): Promise<boolean>;
}

export class InMemoryPinProfileRepository implements PinProfileRepository {
  private readonly items = new Map<string, PinProfile>();

  private key(deviceToken: string, userId: string): string {
    return `${deviceToken}${userId}`;
  }

  async find(deviceToken: string, userId: string): Promise<PinProfile | undefined> {
    const profile = this.items.get(this.key(deviceToken, userId));
    return profile ? { ...profile } : undefined;
  }

  async listForDevice(deviceToken: string): Promise<PinProfile[]> {
    return [...this.items.values()]
      .filter((profile) => profile.deviceToken === deviceToken)
      .map((profile) => ({ ...profile }));
  }

  async countForDevice(deviceToken: string): Promise<number> {
    return (await this.listForDevice(deviceToken)).length;
  }

  async save(profile: PinProfile): Promise<PinProfile> {
    this.items.set(this.key(profile.deviceToken, profile.userId), { ...profile });
    return { ...profile };
  }

  async update(
    deviceToken: string,
    userId: string,
    patch: Partial<Pick<PinProfile, 'pinHash' | 'attempts' | 'lockedUntil'>>
  ): Promise<PinProfile> {
    const key = this.key(deviceToken, userId);
    const existing = this.items.get(key);
    if (!existing) {
      throw new Error(`PIN profile not found for device '${deviceToken}' user '${userId}'`);
    }
    const updated: PinProfile = { ...existing, ...patch };
    this.items.set(key, updated);
    return { ...updated };
  }

  async remove(deviceToken: string, userId: string): Promise<boolean> {
    return this.items.delete(this.key(deviceToken, userId));
  }
}

export function createInMemoryPinProfileRepository(): InMemoryPinProfileRepository {
  return new InMemoryPinProfileRepository();
}
