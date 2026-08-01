import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { Profile } from '@agric-platform/shared';
import { profileMapper } from '../pg/row-mappers.js';
import type { ProfileCriteria, ProfileRepository } from './profile.repository.js';

const COLUMNS = profileMapper.columns.join(', ');

/** Profile repository over profiles.member_profiles, keyed by user_id. */
export class PgProfileRepository implements ProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async all(): Promise<Profile[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM profiles.member_profiles ORDER BY user_id`
    );
    return result.rows.map((row) => profileMapper.fromRow(row));
  }

  async find(criteria: ProfileCriteria): Promise<Profile[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (criteria.userId) {
      params.push(criteria.userId);
      conditions.push(`user_id = $${params.length}`);
    }
    if (criteria.state) {
      params.push(criteria.state);
      conditions.push(`state = $${params.length}`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM profiles.member_profiles${where} ORDER BY user_id`,
      params
    );
    return result.rows.map((row) => profileMapper.fromRow(row));
  }

  async findByUserId(userId: string): Promise<Profile | undefined> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM profiles.member_profiles WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? profileMapper.fromRow(result.rows[0]) : undefined;
  }

  async getByUserId(userId: string): Promise<Profile> {
    const profile = await this.findByUserId(userId);
    if (!profile) {
      throw new NotFoundException(`Profile for user '${userId}' not found`);
    }
    return profile;
  }

  async upsert(profile: Profile): Promise<Profile> {
    const row = profileMapper.toRow(profile);
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => column !== 'user_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO profiles.member_profiles (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${assignments}`,
      columns.map((column) => row[column])
    );
    return profile;
  }

  async countByState(): Promise<Map<string, number>> {
    const result = await this.pool.query(
      `SELECT COALESCE(NULLIF(state, ''), 'unknown') AS key, count(*)::int AS n
         FROM profiles.member_profiles GROUP BY 1`
    );
    return new Map(result.rows.map((row) => [row.key as string, row.n as number]));
  }
}

export function createPgProfileRepository(pool: pg.Pool): PgProfileRepository {
  return new PgProfileRepository(pool);
}
