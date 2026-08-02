import type pg from 'pg';
import type {
  NotificationChannel,
  NotificationMessage,
  NotificationPreference
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  composeWhere,
  eq,
  PgRepositoryBase,
  ts,
  type WhereClause
} from '../pg/pg-repository.base.js';
import { notificationMapper, notificationPreferenceMapper } from '../pg/row-mappers.js';
import type {
  DeliveryLogCriteria,
  DeliveryLogEntry,
  DeliveryLogRepository
} from './delivery-log.repository.js';
import type { NotificationPreferenceRepository } from './notification-preference.repository.js';
import type { NotificationCriteria, NotificationRepository } from './notification.repository.js';

export function notificationCriteriaSql(criteria: NotificationCriteria): WhereClause {
  return composeWhere(eq('user_id', criteria.userId), eq('status', criteria.status));
}

const MESSAGE_COLUMNS = notificationMapper.columns.join(', ');

export class PgNotificationRepository
  extends PgRepositoryBase<NotificationMessage, NotificationCriteria>
  implements NotificationRepository
{
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'notifications.notifications',
      mapper: notificationMapper,
      criteria: notificationCriteriaSql,
      orderBy: 'created_at'
    });
  }

  async countUnread(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT count(*)::int AS n FROM notifications.notifications
        WHERE user_id = $1 AND status <> 'read'`,
      [userId]
    );
    return result.rows[0].n as number;
  }

  /** Delivery log insert + status flip in one transaction (plan §10.15). */
  async recordDelivery(
    id: string,
    status: NotificationMessage['status'],
    entry: DeliveryLogEntry
  ): Promise<NotificationMessage> {
    return this.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO notifications.delivery_logs
           (id, notification_id, provider, provider_ref, status, detail, attempted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          newId('delivery'),
          entry.notificationId,
          entry.result.provider,
          entry.result.providerRef,
          entry.result.delivered ? 'delivered' : 'failed',
          JSON.stringify(entry.result),
          entry.at
        ]
      );
      const result = await client.query(
        `UPDATE notifications.notifications SET status = $2
          WHERE id = $1 RETURNING ${MESSAGE_COLUMNS}`,
        [id, status]
      );
      return notificationMapper.fromRow(result.rows[0]);
    });
  }
}

/** Preference repository over notifications.user_preferences, keyed (user_id, channel). */
export class PgNotificationPreferenceRepository implements NotificationPreferenceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listForUser(userId: string): Promise<NotificationPreference[]> {
    const result = await this.pool.query(
      'SELECT user_id, channel, enabled FROM notifications.user_preferences WHERE user_id = $1 ORDER BY channel',
      [userId]
    );
    return result.rows.map((row) => notificationPreferenceMapper.fromRow(row));
  }

  async find(
    userId: string,
    channel: NotificationChannel
  ): Promise<NotificationPreference | undefined> {
    const result = await this.pool.query(
      'SELECT user_id, channel, enabled FROM notifications.user_preferences WHERE user_id = $1 AND channel = $2',
      [userId, channel]
    );
    return result.rows[0] ? notificationPreferenceMapper.fromRow(result.rows[0]) : undefined;
  }

  async upsert(preference: NotificationPreference): Promise<NotificationPreference> {
    await this.pool.query(
      `INSERT INTO notifications.user_preferences (user_id, channel, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [preference.userId, preference.channel, preference.enabled]
    );
    return preference;
  }
}

/** Append-only delivery log over notifications.delivery_logs. */
export class PgDeliveryLogRepository implements DeliveryLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(entry: DeliveryLogEntry): Promise<DeliveryLogEntry> {
    await this.pool.query(
      `INSERT INTO notifications.delivery_logs
         (id, notification_id, provider, provider_ref, status, detail, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId('delivery'),
        entry.notificationId,
        entry.result.provider,
        entry.result.providerRef,
        entry.result.delivered ? 'delivered' : 'failed',
        JSON.stringify(entry.result),
        entry.at
      ]
    );
    return entry;
  }

  async list(criteria?: DeliveryLogCriteria): Promise<DeliveryLogEntry[]> {
    const params: unknown[] = [];
    let where = '';
    if (criteria?.notificationId) {
      params.push(criteria.notificationId);
      where = ' WHERE notification_id = $1';
    }
    const result = await this.pool.query(
      `SELECT notification_id, detail, attempted_at FROM notifications.delivery_logs${where}
        ORDER BY attempted_at`,
      params
    );
    return result.rows.map((row) => ({
      notificationId: row.notification_id as string,
      result: row.detail as DeliveryLogEntry['result'],
      at: ts(row.attempted_at)
    }));
  }
}

export function createPgNotificationRepository(pool: pg.Pool): PgNotificationRepository {
  return new PgNotificationRepository(pool);
}

export function createPgNotificationPreferenceRepository(
  pool: pg.Pool
): PgNotificationPreferenceRepository {
  return new PgNotificationPreferenceRepository(pool);
}

export function createPgDeliveryLogRepository(pool: pg.Pool): PgDeliveryLogRepository {
  return new PgDeliveryLogRepository(pool);
}
