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
  /**
   * Atomically increments the wrong-PIN attempt counter and returns the new
   * count (audit C2-5). A read-modify-write through find+update loses
   * concurrent increments, letting parallel wrong PINs defeat the lockout;
   * implementations must make the increment indivisible (single UPDATE on
   * Postgres; synchronous read-increment-write in memory).
   */
  incrementAttempts(deviceToken: string, userId: string): Promise<number>;
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

  async incrementAttempts(deviceToken: string, userId: string): Promise<number> {
    // No awaits between the read and the write: the JS event loop runs this
    // whole block synchronously, so concurrent callers cannot interleave and
    // every failed attempt is counted exactly once.
    const key = this.key(deviceToken, userId);
    const existing = this.items.get(key);
    if (!existing) {
      throw new Error(`PIN profile not found for device '${deviceToken}' user '${userId}'`);
    }
    const updated: PinProfile = { ...existing, attempts: existing.attempts + 1 };
    this.items.set(key, updated);
    return updated.attempts;
  }

  async remove(deviceToken: string, userId: string): Promise<boolean> {
    return this.items.delete(this.key(deviceToken, userId));
  }
}

export function createInMemoryPinProfileRepository(): InMemoryPinProfileRepository {
  return new InMemoryPinProfileRepository();
}
