import {
  BadRequestException,
  ConflictException,
  NotFoundException
} from '@nestjs/common';
import type pg from 'pg';
import type { ApiListResponse } from '@agric-platform/shared';
import { pageSlice } from '../../common/pagination.js';

/** snake_case row ↔ camelCase entity mapping, explicit per entity. */
export interface RowMapper<T> {
  /** Column list used in SELECT statements. */
  readonly columns: readonly string[];
  fromRow(row: Record<string, unknown>): T;
  toRow(item: T): Record<string, unknown>;
}

/**
 * Compiles a criteria object into a WHERE fragment with positional $n
 * parameters. Implementations must compose whitelisted column fragments
 * only — never string-concatenate user input.
 */
export type CriteriaSqlBuilder<TCriteria> = (criteria: TCriteria) => WhereClause;

export interface WhereClause {
  where: string;
  params: unknown[];
}

/** Composes non-empty fragments with AND and renumbers placeholders. */
export function composeWhere(...fragments: Array<WhereClause | null>): WhereClause {
  const active = fragments.filter((fragment): fragment is WhereClause => fragment !== null);
  if (active.length === 0) {
    return { where: '', params: [] };
  }
  const params: unknown[] = [];
  const parts = active.map((fragment) => {
    const offset = params.length;
    params.push(...fragment.params);
    const renumbered = fragment.where.replace(/\$(\d+)/g, (_match, n: string) => `$${Number(n) + offset}`);
    return `(${renumbered})`;
  });
  return { where: ` WHERE ${parts.join(' AND ')}`, params };
}

export function eq(column: string, value: unknown): WhereClause | null {
  return value === undefined ? null : { where: `${column} = $1`, params: [value] };
}

export function ilike(column: string, value: string | undefined): WhereClause | null {
  return value === undefined ? null : { where: `${column} ILIKE $1`, params: [`%${value}%`] };
}

/** Array containment: column @> ARRAY[$1] — matches rows whose array contains the value. */
export function arrayContains(column: string, value: string | undefined): WhereClause | null {
  return value === undefined ? null : { where: `${column} @> ARRAY[$1]::text[]`, params: [value] };
}

/** Maps node-postgres error codes onto Nest exceptions (plan §2.3). */
export function mapPgError(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === '23505') {
    throw new ConflictException('A record with these unique values already exists');
  }
  if (code === '23503') {
    throw new BadRequestException('Referenced record does not exist');
  }
  throw error;
}

export interface PgRepositoryOptions<T, TCriteria> {
  table: string;
  mapper: RowMapper<T>;
  criteria?: CriteriaSqlBuilder<TCriteria>;
  /** Stable pagination ordering (defaults to id). */
  orderBy?: string;
}

/**
 * Thin PostgreSQL repository base (plan §2.3). Wraps pg.Pool with
 * hand-rolled SQL; criteria compile through whitelisted builders.
 */
export abstract class PgRepositoryBase<T extends { id: string }, TCriteria> {
  constructor(
    protected readonly pool: pg.Pool,
    protected readonly options: PgRepositoryOptions<T, TCriteria>
  ) {}

  protected get table(): string {
    return this.options.table;
  }

  protected get mapper(): RowMapper<T> {
    return this.options.mapper;
  }

  private selectList(): string {
    return this.mapper.columns.join(', ');
  }

  protected where(criteria: TCriteria): WhereClause {
    if (!this.options.criteria) {
      throw new Error(`${this.table}: no criteria builder configured`);
    }
    return this.options.criteria(criteria);
  }

  async all(): Promise<T[]> {
    const result = await this.pool.query(
      `SELECT ${this.selectList()} FROM ${this.table} ORDER BY ${this.options.orderBy ?? 'id'}`
    );
    return result.rows.map((row) => this.mapper.fromRow(row));
  }

  async find(criteria: TCriteria): Promise<T[]> {
    const { where, params } = this.where(criteria);
    const result = await this.pool.query(
      `SELECT ${this.selectList()} FROM ${this.table}${where} ORDER BY ${this.options.orderBy ?? 'id'}`,
      params
    );
    return result.rows.map((row) => this.mapper.fromRow(row));
  }

  async findOne(criteria: TCriteria): Promise<T | undefined> {
    const { where, params } = this.where(criteria);
    const result = await this.pool.query(
      `SELECT ${this.selectList()} FROM ${this.table}${where} LIMIT 1`,
      params
    );
    return result.rows[0] ? this.mapper.fromRow(result.rows[0]) : undefined;
  }

  async findById(id: string): Promise<T | undefined> {
    const result = await this.pool.query(
      `SELECT ${this.selectList()} FROM ${this.table} WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapper.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<T> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return item;
  }

  async create(item: T): Promise<T> {
    const row = this.mapper.toRow(item);
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    try {
      await this.pool.query(
        `INSERT INTO ${this.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );
    } catch (error) {
      mapPgError(error);
    }
    return item;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const row = this.mapper.toRow(patch as T);
    const columns = Object.keys(row).filter((column) => column !== 'id');
    if (columns.length === 0) {
      return this.getById(id);
    }
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    const values = columns.map((column) => row[column]);
    const result = await this.pool.query(
      `UPDATE ${this.table} SET ${assignments} WHERE id = $1 RETURNING ${this.selectList()}`,
      [id, ...values]
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return this.mapper.fromRow(result.rows[0]);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async count(criteria?: TCriteria): Promise<number> {
    const clause = criteria !== undefined ? this.where(criteria) : { where: '', params: [] };
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM ${this.table}${clause.where}`,
      clause.params
    );
    return result.rows[0].n as number;
  }

  /** Pagination pushed into SQL: LIMIT/OFFSET plus a COUNT(*) total. */
  async searchPage(
    criteria: TCriteria,
    page = 1,
    pageSize = 20
  ): Promise<ApiListResponse<T>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const { where, params } = this.where(criteria);
    const offset = (safePage - 1) * safeSize;
    const [data, total] = await Promise.all([
      this.pool.query(
        `SELECT ${this.selectList()} FROM ${this.table}${where}
         ORDER BY ${this.options.orderBy ?? 'id'} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, safeSize, offset]
      ),
      this.pool.query(`SELECT count(*)::int AS n FROM ${this.table}${where}`, params)
    ]);
    return pageSlice(
      total.rows[0].n as number,
      data.rows.map((row) => this.mapper.fromRow(row)),
      safePage,
      safeSize
    );
  }

  /**
   * Runs fn inside a transaction. Transactions stay inside repositories —
   * PoolClients never leak into services.
   */
  protected async withTransaction<R>(fn: (client: pg.PoolClient) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** timestamptz row value → ISO string (pg returns Date objects). */
export function ts(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value as string;
}

/** numeric row value → number (pg returns strings for numeric). */
export function num(value: unknown): number {
  return Number(value);
}
