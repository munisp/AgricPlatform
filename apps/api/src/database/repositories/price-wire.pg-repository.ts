import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  PriceDispatch,
  PriceSubscription,
  PriceSubscriptionCriteria,
  PriceWireRepository,
  WireChannel
} from './price-wire.repository.js';

/** Postgres unique-violation code (delivered-dedupe / dedupe-key races). */
const PG_UNIQUE_VIOLATION = '23505';

const SUBSCRIPTION_COLUMNS =
  'id, user_id, commodity, market_id, channel, cadence, last_sent_at, status, created_at, updated_at';

const DISPATCH_COLUMNS =
  'id, subscription_id, quote_as_of, body_hash, channel, basis, delivery_status, detail, created_at, sent_at';

/**
 * PostgreSQL implementation over advisory.price_subscriptions and
 * advisory.price_dispatches (migration 069). Standalone (not
 * PgRepositoryBase): the port needs guarded writes (status-guarded stop,
 * conflict-safe delivered insert) and cadence-aware due-for-dispatch
 * selection that the generic base does not model.
 */
export class PgPriceWireRepository implements PriceWireRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createSubscription(subscription: PriceSubscription): Promise<PriceSubscription> {
    try {
      await this.pool.query(
        'INSERT INTO advisory.price_subscriptions ' +
          '(id, user_id, commodity, market_id, channel, cadence, last_sent_at, status, created_at, updated_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          subscription.id,
          subscription.userId,
          subscription.commodity,
          subscription.marketId,
          subscription.channel,
          subscription.cadence,
          subscription.lastSentAt ?? null,
          subscription.status,
          subscription.createdAt,
          subscription.updatedAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          `A ${subscription.channel} price subscription for '${subscription.commodity}' at ` +
            `'${subscription.marketId}' already exists for this user`
        );
      }
      throw error;
    }
    return subscription;
  }

  async findSubscriptions(criteria: PriceSubscriptionCriteria): Promise<PriceSubscription[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.userId) {
      params.push(criteria.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (criteria.commodity) {
      params.push(criteria.commodity);
      where.push(`commodity = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.price_subscriptions` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at',
      params
    );
    return result.rows.map((row) => this.subscriptionFromRow(row));
  }

  async findSubscriptionById(id: string): Promise<PriceSubscription | undefined> {
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.price_subscriptions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.subscriptionFromRow(result.rows[0]) : undefined;
  }

  async getSubscriptionById(id: string): Promise<PriceSubscription> {
    const found = await this.findSubscriptionById(id);
    if (!found) {
      throw new NotFoundException(`Price subscription '${id}' not found`);
    }
    return found;
  }

  async findByDedupeKey(
    userId: string,
    commodity: string,
    marketId: string,
    channel: WireChannel
  ): Promise<PriceSubscription | undefined> {
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.price_subscriptions ` +
        'WHERE user_id = $1 AND commodity = $2 AND market_id = $3 AND channel = $4',
      [userId, commodity, marketId, channel]
    );
    return result.rows[0] ? this.subscriptionFromRow(result.rows[0]) : undefined;
  }

  async updateSubscription(
    id: string,
    patch: Partial<PriceSubscription>
  ): Promise<PriceSubscription> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.channel !== undefined) push('channel', patch.channel);
    if (patch.cadence !== undefined) push('cadence', patch.cadence);
    if (patch.lastSentAt !== undefined) push('last_sent_at', patch.lastSentAt);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.updatedAt !== undefined) push('updated_at', patch.updatedAt);
    if (assignments.length === 0) {
      return this.getSubscriptionById(id);
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE advisory.price_subscriptions SET ${assignments.join(', ')} ` +
        `WHERE id = $${params.length} RETURNING ${SUBSCRIPTION_COLUMNS}`,
      params
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Price subscription '${id}' not found`);
    }
    return this.subscriptionFromRow(result.rows[0]);
  }

  async stopSubscription(id: string): Promise<PriceSubscription> {
    // Guarded write: only a non-stopped row transitions, so a concurrent
    // double-stop cannot fork state; a replay then reads the stopped row.
    const result = await this.pool.query(
      `UPDATE advisory.price_subscriptions SET status = 'stopped', updated_at = now() ` +
        `WHERE id = $1 AND status <> 'stopped' RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [id]
    );
    if (result.rows[0]) {
      return this.subscriptionFromRow(result.rows[0]);
    }
    return this.getSubscriptionById(id);
  }

  async listDueForDispatch(
    dailyCutoffIso: string,
    weeklyCutoffIso: string
  ): Promise<PriceSubscription[]> {
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.price_subscriptions ` +
        `WHERE status = 'active' AND channel <> 'ussd' ` +
        `AND (last_sent_at IS NULL OR (cadence = 'daily' AND last_sent_at <= $1) ` +
        `OR (cadence = 'weekly' AND last_sent_at <= $2)) ORDER BY created_at`,
      [dailyCutoffIso, weeklyCutoffIso]
    );
    return result.rows.map((row) => this.subscriptionFromRow(row));
  }

  async recordDispatch(dispatch: PriceDispatch): Promise<PriceDispatch> {
    try {
      await this.pool.query(
        'INSERT INTO advisory.price_dispatches ' +
          '(id, subscription_id, quote_as_of, body_hash, channel, basis, delivery_status, detail, created_at, sent_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          dispatch.id,
          dispatch.subscriptionId,
          dispatch.quoteAsOf ?? null,
          dispatch.bodyHash ?? null,
          dispatch.channel,
          dispatch.basis,
          dispatch.deliveryStatus,
          dispatch.detail ?? null,
          dispatch.createdAt,
          dispatch.sentAt ?? null
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          'This price quote was already delivered for the subscription'
        );
      }
      throw error;
    }
    return dispatch;
  }

  async dispatchesFor(subscriptionId: string): Promise<PriceDispatch[]> {
    const result = await this.pool.query(
      `SELECT ${DISPATCH_COLUMNS} FROM advisory.price_dispatches ` +
        'WHERE subscription_id = $1 ORDER BY created_at, id',
      [subscriptionId]
    );
    return result.rows.map((row) => this.dispatchFromRow(row));
  }

  async hasDeliveredBody(subscriptionId: string, bodyHash: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM advisory.price_dispatches ' +
        `WHERE subscription_id = $1 AND body_hash = $2 AND delivery_status = 'delivered' LIMIT 1`,
      [subscriptionId, bodyHash]
    );
    return result.rows.length > 0;
  }

  private subscriptionFromRow(row: Record<string, unknown>): PriceSubscription {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      commodity: row.commodity as string,
      marketId: row.market_id as string,
      channel: row.channel as PriceSubscription['channel'],
      cadence: row.cadence as PriceSubscription['cadence'],
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at as string).toISOString() : undefined,
      status: row.status as PriceSubscription['status'],
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString()
    };
  }

  private dispatchFromRow(row: Record<string, unknown>): PriceDispatch {
    return {
      id: row.id as string,
      subscriptionId: row.subscription_id as string,
      quoteAsOf: row.quote_as_of ? new Date(row.quote_as_of as string).toISOString() : undefined,
      bodyHash: (row.body_hash as string | null) ?? undefined,
      channel: row.channel as PriceDispatch['channel'],
      basis: row.basis as PriceDispatch['basis'],
      deliveryStatus: row.delivery_status as PriceDispatch['deliveryStatus'],
      detail: (row.detail as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at as string).toISOString() : undefined
    };
  }
}

export function createPgPriceWireRepository(pool: pg.Pool): PgPriceWireRepository {
  return new PgPriceWireRepository(pool);
}
