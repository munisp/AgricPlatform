import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  AdvisoryDispatch,
  AdvisoryPulseRepository,
  PlotAdvisorySubscription,
  PulseSubscriptionCriteria
} from './advisory-pulse.repository.js';

/** Postgres unique-violation code (delivered-dedupe / active-key races). */
const PG_UNIQUE_VIOLATION = '23505';

const SUBSCRIPTION_COLUMNS =
  'id, plot_id, user_id, channel, crop, h3_res9, locale, planting_window, ' +
  'last_sent_at, consent_id, status, created_at, updated_at';

const DISPATCH_COLUMNS =
  'id, subscription_id, window_start, body_hash, channel, basis, delivery_status, ' +
  'detail, rule_version, created_at, sent_at';

/**
 * PostgreSQL implementation over advisory.plot_advisory_subscriptions and
 * advisory.advisory_dispatches (migration 058). Standalone (not
 * PgRepositoryBase): the port needs guarded writes (status-guarded stop,
 * conflict-safe delivered insert) and due-for-dispatch selection that the
 * generic base does not model.
 */
export class PgAdvisoryPulseRepository implements AdvisoryPulseRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createSubscription(
    subscription: PlotAdvisorySubscription
  ): Promise<PlotAdvisorySubscription> {
    try {
      await this.pool.query(
        'INSERT INTO advisory.plot_advisory_subscriptions ' +
          '(id, plot_id, user_id, channel, crop, h3_res9, locale, planting_window, last_sent_at, consent_id, status, created_at, updated_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          subscription.id,
          subscription.plotId,
          subscription.userId,
          subscription.channel,
          subscription.crop,
          subscription.h3Res9 ?? null,
          subscription.locale,
          subscription.plantingWindow ? JSON.stringify(subscription.plantingWindow) : null,
          subscription.lastSentAt ?? null,
          subscription.consentId ?? null,
          subscription.status,
          subscription.createdAt,
          subscription.updatedAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          `An active ${subscription.channel} subscription for crop '${subscription.crop}' already exists for this plot`
        );
      }
      throw error;
    }
    return subscription;
  }

  async findSubscriptions(criteria: PulseSubscriptionCriteria): Promise<PlotAdvisorySubscription[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.userId) {
      params.push(criteria.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (criteria.plotId) {
      params.push(criteria.plotId);
      where.push(`plot_id = $${params.length}`);
    }
    if (criteria.status) {
      params.push(criteria.status);
      where.push(`status = $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.plot_advisory_subscriptions` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at',
      params
    );
    return result.rows.map((row) => this.subscriptionFromRow(row));
  }

  async findSubscriptionById(id: string): Promise<PlotAdvisorySubscription | undefined> {
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.plot_advisory_subscriptions WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.subscriptionFromRow(result.rows[0]) : undefined;
  }

  async getSubscriptionById(id: string): Promise<PlotAdvisorySubscription> {
    const found = await this.findSubscriptionById(id);
    if (!found) {
      throw new NotFoundException(`Advisory subscription '${id}' not found`);
    }
    return found;
  }

  async updateSubscription(
    id: string,
    patch: Partial<PlotAdvisorySubscription>
  ): Promise<PlotAdvisorySubscription> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    if (patch.channel !== undefined) push('channel', patch.channel);
    if (patch.crop !== undefined) push('crop', patch.crop);
    if (patch.h3Res9 !== undefined) push('h3_res9', patch.h3Res9);
    if (patch.locale !== undefined) push('locale', patch.locale);
    if (patch.plantingWindow !== undefined) {
      push('planting_window', patch.plantingWindow ? JSON.stringify(patch.plantingWindow) : null);
    }
    if (patch.lastSentAt !== undefined) push('last_sent_at', patch.lastSentAt);
    if (patch.consentId !== undefined) push('consent_id', patch.consentId);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.updatedAt !== undefined) push('updated_at', patch.updatedAt);
    if (assignments.length === 0) {
      return this.getSubscriptionById(id);
    }
    params.push(id);
    const result = await this.pool.query(
      `UPDATE advisory.plot_advisory_subscriptions SET ${assignments.join(', ')} ` +
        `WHERE id = $${params.length} RETURNING ${SUBSCRIPTION_COLUMNS}`,
      params
    );
    if (!result.rows[0]) {
      throw new NotFoundException(`Advisory subscription '${id}' not found`);
    }
    return this.subscriptionFromRow(result.rows[0]);
  }

  async stopSubscription(id: string): Promise<PlotAdvisorySubscription> {
    // Guarded write: only a non-stopped row transitions, so a concurrent
    // double-stop cannot fork state; a replay then reads the stopped row.
    const result = await this.pool.query(
      `UPDATE advisory.plot_advisory_subscriptions SET status = 'stopped', updated_at = now() ` +
        `WHERE id = $1 AND status <> 'stopped' RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [id]
    );
    if (result.rows[0]) {
      return this.subscriptionFromRow(result.rows[0]);
    }
    return this.getSubscriptionById(id);
  }

  async listDueForDispatch(sentBeforeIso: string): Promise<PlotAdvisorySubscription[]> {
    const result = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM advisory.plot_advisory_subscriptions ` +
        `WHERE status = 'active' AND channel <> 'ussd' ` +
        'AND (last_sent_at IS NULL OR last_sent_at <= $1) ORDER BY created_at',
      [sentBeforeIso]
    );
    return result.rows.map((row) => this.subscriptionFromRow(row));
  }

  async recordDispatch(dispatch: AdvisoryDispatch): Promise<AdvisoryDispatch> {
    try {
      await this.pool.query(
        'INSERT INTO advisory.advisory_dispatches ' +
          '(id, subscription_id, window_start, body_hash, channel, basis, delivery_status, detail, rule_version, created_at, sent_at) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          dispatch.id,
          dispatch.subscriptionId,
          dispatch.windowStart ?? null,
          dispatch.bodyHash ?? null,
          dispatch.channel,
          dispatch.basis,
          dispatch.deliveryStatus,
          dispatch.detail ?? null,
          dispatch.ruleVersion ?? null,
          dispatch.createdAt,
          dispatch.sentAt ?? null
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(
          'This planting window was already delivered for the subscription'
        );
      }
      throw error;
    }
    return dispatch;
  }

  async dispatchesFor(subscriptionId: string): Promise<AdvisoryDispatch[]> {
    const result = await this.pool.query(
      `SELECT ${DISPATCH_COLUMNS} FROM advisory.advisory_dispatches ` +
        'WHERE subscription_id = $1 ORDER BY created_at, id',
      [subscriptionId]
    );
    return result.rows.map((row) => this.dispatchFromRow(row));
  }

  async hasDeliveredBody(subscriptionId: string, bodyHash: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM advisory.advisory_dispatches ' +
        `WHERE subscription_id = $1 AND body_hash = $2 AND delivery_status = 'delivered' LIMIT 1`,
      [subscriptionId, bodyHash]
    );
    return result.rows.length > 0;
  }

  private subscriptionFromRow(row: Record<string, unknown>): PlotAdvisorySubscription {
    return {
      id: row.id as string,
      plotId: row.plot_id as string,
      userId: row.user_id as string,
      channel: row.channel as PlotAdvisorySubscription['channel'],
      crop: row.crop as string,
      h3Res9: (row.h3_res9 as string | null) ?? undefined,
      locale: row.locale as string,
      plantingWindow: (row.planting_window as Record<string, unknown> | null) ?? undefined,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at as string).toISOString() : undefined,
      consentId: (row.consent_id as string | null) ?? undefined,
      status: row.status as PlotAdvisorySubscription['status'],
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString()
    };
  }

  private dispatchFromRow(row: Record<string, unknown>): AdvisoryDispatch {
    return {
      id: row.id as string,
      subscriptionId: row.subscription_id as string,
      windowStart: (row.window_start as string | null) ?? undefined,
      bodyHash: (row.body_hash as string | null) ?? undefined,
      channel: row.channel as AdvisoryDispatch['channel'],
      basis: row.basis as AdvisoryDispatch['basis'],
      deliveryStatus: row.delivery_status as AdvisoryDispatch['deliveryStatus'],
      detail: (row.detail as string | null) ?? undefined,
      ruleVersion: (row.rule_version as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      sentAt: row.sent_at ? new Date(row.sent_at as string).toISOString() : undefined
    };
  }
}

export function createPgAdvisoryPulseRepository(pool: pg.Pool): PgAdvisoryPulseRepository {
  return new PgAdvisoryPulseRepository(pool);
}
