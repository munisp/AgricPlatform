import type pg from 'pg';
import type { PinProfile, PinProfileRepository } from './pin-profile.repository.js';

/**
 * PostgreSQL implementation over channels.pin_profiles
 * (infra/postgres/008_ussd_channels.sql). Standalone (not PgRepositoryBase)
 * because the primary key is the composite (device_token, user_id).
 */
export class PgPinProfileRepository implements PinProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async find(deviceToken: string, userId: string): Promise<PinProfile | undefined> {
    const result = await this.pool.query(
      'SELECT device_token, user_id, pin_hash, attempts, locked_until, created_at ' +
        'FROM channels.pin_profiles WHERE device_token = $1 AND user_id = $2',
      [deviceToken, userId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async listForDevice(deviceToken: string): Promise<PinProfile[]> {
    const result = await this.pool.query(
      'SELECT device_token, user_id, pin_hash, attempts, locked_until, created_at ' +
        'FROM channels.pin_profiles WHERE device_token = $1 ORDER BY created_at, user_id',
      [deviceToken]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async countForDevice(deviceToken: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT count(*)::int AS total FROM channels.pin_profiles WHERE device_token = $1',
      [deviceToken]
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async save(profile: PinProfile): Promise<PinProfile> {
    await this.pool.query(
      'INSERT INTO channels.pin_profiles (device_token, user_id, pin_hash, attempts, locked_until, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'ON CONFLICT (device_token, user_id) DO UPDATE SET ' +
        'pin_hash = EXCLUDED.pin_hash, attempts = EXCLUDED.attempts, locked_until = EXCLUDED.locked_until',
      [
        profile.deviceToken,
        profile.userId,
        profile.pinHash,
        profile.attempts,
        profile.lockedUntil ?? null,
        profile.createdAt
      ]
    );
    return profile;
  }

  async update(
    deviceToken: string,
    userId: string,
    patch: Partial<Pick<PinProfile, 'pinHash' | 'attempts' | 'lockedUntil'>>
  ): Promise<PinProfile> {
    const existing = await this.find(deviceToken, userId);
    if (!existing) {
      throw new Error(`PIN profile not found for device '${deviceToken}' user '${userId}'`);
    }
    const updated: PinProfile = { ...existing, ...patch };
    await this.save(updated);
    return updated;
  }

  /**
   * Single-statement atomic increment (audit C2-5): concurrent wrong-PIN
   * requests cannot lose updates the way the previous find+update
   * read-modify-write cycle could.
   */
  async incrementAttempts(deviceToken: string, userId: string): Promise<number> {
    const result = await this.pool.query(
      'UPDATE channels.pin_profiles SET attempts = attempts + 1 ' +
        'WHERE device_token = $1 AND user_id = $2 RETURNING attempts',
      [deviceToken, userId]
    );
    if (!result.rows[0]) {
      throw new Error(`PIN profile not found for device '${deviceToken}' user '${userId}'`);
    }
    return Number(result.rows[0].attempts);
  }

  async remove(deviceToken: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM channels.pin_profiles WHERE device_token = $1 AND user_id = $2',
      [deviceToken, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private fromRow(row: Record<string, unknown>): PinProfile {
    return {
      deviceToken: row.device_token as string,
      userId: row.user_id as string,
      pinHash: row.pin_hash as string,
      attempts: Number(row.attempts),
      lockedUntil: row.locked_until
        ? new Date(row.locked_until as string).toISOString()
        : undefined,
      createdAt: new Date(row.created_at as string).toISOString()
    };
  }
}

export function createPgPinProfileRepository(pool: pg.Pool): PgPinProfileRepository {
  return new PgPinProfileRepository(pool);
}
