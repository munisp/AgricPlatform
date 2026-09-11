import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { PinProfile, PinProfilePatch, PinProfileRepository } from './pin-profile.repository.js';

/**
 * PostgreSQL implementation over channels.pin_profiles (migration 024).
 * incrementAttempts is a single atomic UPDATE (audit C2-5); a FOR UPDATE
 * variant would only matter under a transactions-per-call redesign.
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

  async listForUser(userId: string): Promise<PinProfile[]> {
    const result = await this.pool.query(
      'SELECT device_token, user_id, pin_hash, attempts, locked_until, created_at ' +
        'FROM channels.pin_profiles WHERE user_id = $1 ORDER BY created_at, device_token',
      [userId]
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  async save(profile: PinProfile): Promise<PinProfile> {
    await this.pool.query(
      'INSERT INTO channels.pin_profiles (device_token, user_id, pin_hash, attempts, locked_until, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6) ' +
        'ON CONFLICT (device_token, user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash',
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

  async update(deviceToken: string, userId: string, patch: PinProfilePatch): Promise<PinProfile> {
    const existing = await this.find(deviceToken, userId);
    if (!existing) {
      throw new NotFoundException(`PIN profile ${userId} on ${deviceToken} not found`);
    }
    const next: PinProfile = {
      ...existing,
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      ...(patch.lockedUntil !== undefined ? { lockedUntil: patch.lockedUntil } : {})
    };
    await this.pool.query(
      'UPDATE channels.pin_profiles SET attempts = $3, locked_until = $4 ' +
        'WHERE device_token = $1 AND user_id = $2',
      [deviceToken, userId, next.attempts, next.lockedUntil ?? null]
    );
    return next;
  }

  /** Atomic increment — the UPDATE itself is the row lock. */
  async incrementAttempts(deviceToken: string, userId: string): Promise<number> {
    const result = await this.pool.query(
      'UPDATE channels.pin_profiles SET attempts = attempts + 1 ' +
        'WHERE device_token = $1 AND user_id = $2 RETURNING attempts',
      [deviceToken, userId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundException(`PIN profile ${userId} on ${deviceToken} not found`);
    }
    return Number(result.rows[0].attempts);
  }

  async countForDevice(deviceToken: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) AS count FROM channels.pin_profiles WHERE device_token = $1',
      [deviceToken]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private fromRow(row: Record<string, unknown>): PinProfile {
    return {
      deviceToken: String(row.device_token),
      userId: String(row.user_id),
      pinHash: String(row.pin_hash),
      attempts: Number(row.attempts),
      lockedUntil: row.locked_until ? new Date(String(row.locked_until)).toISOString() : undefined,
      createdAt: new Date(String(row.created_at)).toISOString()
    };
  }
}

export function createPgPinProfileRepository(pool: pg.Pool): PgPinProfileRepository {
  return new PgPinProfileRepository(pool);
}
