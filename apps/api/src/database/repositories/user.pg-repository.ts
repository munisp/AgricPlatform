import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type { ApiListResponse, User, UserRole } from '@agric-platform/shared';
import { pageSlice } from '../../common/pagination.js';
import {
  composeWhere,
  mapPgError,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { userMapper } from '../pg/row-mappers.js';
import type { AccountStatus, UserCriteria, UserRepository } from './user.repository.js';

const USER_SELECT = `
  SELECT u.id, u.phone, u.email, u.full_name, u.preferred_language, u.kyc_tier,
         u.is_verified, u.created_at, u.last_active_at,
         COALESCE(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles
    FROM identity.users u
    LEFT JOIN identity.user_roles ur ON ur.user_id = u.id`;

/** Whitelisted criteria fragments (roles hydrated via the user_roles join). */
export function userCriteriaSql(criteria: UserCriteria): WhereClause {
  const fragments: Array<WhereClause | null> = [];
  if (criteria.role) {
    fragments.push({
      where: `EXISTS (SELECT 1 FROM identity.user_roles ur2
                      WHERE ur2.user_id = u.id AND ur2.role_code = $1)`,
      params: [criteria.role]
    });
  }
  if (criteria.q) {
    fragments.push({
      where: `(u.full_name ILIKE $1 OR u.phone ILIKE $2)`,
      params: [`%${criteria.q}%`, `%${criteria.q}%`]
    });
  }
  return composeWhere(...fragments);
}

/** User repository over identity.users + identity.user_roles (plan §2.4). */
export class PgUserRepository implements UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async queryUsers(where: WhereClause, suffix = ''): Promise<User[]> {
    const result = await this.pool.query(`${USER_SELECT}${where.where} GROUP BY u.id${suffix}`, where.params);
    return result.rows.map((row) => userMapper.fromRow(row));
  }

  async all(): Promise<User[]> {
    return this.queryUsers({ where: '', params: [] }, ' ORDER BY u.id');
  }

  async find(criteria: UserCriteria): Promise<User[]> {
    return this.queryUsers(userCriteriaSql(criteria), ' ORDER BY u.id');
  }

  async findOne(criteria: UserCriteria): Promise<User | undefined> {
    return (await this.queryUsers(userCriteriaSql(criteria), ' LIMIT 1'))[0];
  }

  async findById(id: string): Promise<User | undefined> {
    return (await this.queryUsers({ where: ' WHERE u.id = $1', params: [id] }, ''))[0];
  }

  async getById(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return user;
  }

  async create(item: User): Promise<User> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = userMapper.toRow(item);
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO identity.users (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
      for (const role of item.roles) {
        await client.query(
          'INSERT INTO identity.user_roles (user_id, role_code) VALUES ($1, $2)',
          [item.id, role]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      mapPgError(error);
    } finally {
      client.release();
    }
    return item;
  }

  async update(id: string, patch: Partial<User>): Promise<User> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = userMapper.toRow(patch as User);
      const columns = Object.keys(row).filter((column) => column !== 'id');
      if (columns.length > 0) {
        const result = await client.query(
          `UPDATE identity.users
              SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')}
            WHERE id = $1`,
          [id, ...columns.map((column) => row[column])]
        );
        if ((result.rowCount ?? 0) === 0) {
          throw new NotFoundException(`Resource with id '${id}' not found`);
        }
      }
      if (patch.roles) {
        await client.query('DELETE FROM identity.user_roles WHERE user_id = $1', [id]);
        for (const role of patch.roles) {
          await client.query(
            'INSERT INTO identity.user_roles (user_id, role_code) VALUES ($1, $2)',
            [id, role]
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof NotFoundException) {
        throw error;
      }
      mapPgError(error);
    } finally {
      client.release();
    }
    return this.getById(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM identity.users WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async count(criteria?: UserCriteria): Promise<number> {
    const clause = criteria !== undefined ? userCriteriaSql(criteria) : { where: '', params: [] };
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM identity.users u${clause.where}`,
      clause.params
    );
    return result.rows[0].n as number;
  }

  async searchPage(criteria: UserCriteria, page = 1, pageSize = 20): Promise<ApiListResponse<User>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const clause = userCriteriaSql(criteria);
    const [paged, total] = await Promise.all([
      this.pool.query(
        `${USER_SELECT}${clause.where} GROUP BY u.id ORDER BY u.id
         LIMIT $${clause.params.length + 1} OFFSET $${clause.params.length + 2}`,
        [...clause.params, safeSize, (safePage - 1) * safeSize]
      ),
      this.count(criteria)
    ]);
    return pageSlice(
      total,
      paged.rows.map((row) => userMapper.fromRow(row)),
      safePage,
      safeSize
    );
  }

  async countByRole(role: UserRole): Promise<number> {
    return this.count({ role });
  }

  async findByPhone(phone: string): Promise<User | undefined> {
    return (await this.queryUsers({ where: ' WHERE u.phone = $1', params: [phone] }, ' LIMIT 1'))[0];
  }

  async setStatus(userId: string, status: AccountStatus): Promise<void> {
    const result = await this.pool.query('UPDATE identity.users SET status = $2 WHERE id = $1', [
      userId,
      status
    ]);
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException(`Resource with id '${userId}' not found`);
    }
  }

  async statusFor(userId: string): Promise<AccountStatus> {
    const result = await this.pool.query('SELECT status FROM identity.users WHERE id = $1', [userId]);
    return (result.rows[0]?.status as AccountStatus | undefined) ?? 'active';
  }
}

export function createPgUserRepository(pool: pg.Pool): PgUserRepository {
  return new PgUserRepository(pool);
}
