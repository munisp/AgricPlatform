import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Gauge, register, Registry, type CollectFunction, type PrometheusContentType } from 'prom-client';
import type { EscrowStatus } from '@agric-platform/shared';
import {
  DELIVERY_LOG_REPOSITORY,
  ESCROW_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OUTBOX_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { DeliveryLogRepository } from '../../database/repositories/delivery-log.repository.js';
import type { EscrowRepository } from '../../database/repositories/escrow.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import type { OutboxRepository } from '../../database/repositories/outbox.repository.js';

/** Escrow states in which buyer funds are still locked on the platform. */
export const ESCROW_LOCKED_STATUSES: readonly EscrowStatus[] = [
  'held',
  'disputed',
  'releasing',
  'refunding'
];

/**
 * Operational gauges (observability wave): scrape-time snapshots of the
 * platform backlogs that SLO alerts fire on — outbox backlog/age,
 * notification queue + DLQ depth, and escrow funds still locked.
 *
 * Values are computed in `collect` callbacks, i.e. on every Prometheus
 * scrape, so no scheduler or timer runs in-process. A collector that throws
 * (e.g. database briefly unreachable) logs and leaves the previous reading
 * in place — a broken scrape is far worse than a stale gauge.
 *
 * Gauges are fetched from (or registered on) the prom-client default
 * registry so several Nest application contexts can boot in one process
 * (e2e suites): the first context's collectors stay registered.
 */
@Injectable()
export class OperationalMetricsService {
  private readonly logger = new Logger(OperationalMetricsService.name);

  readonly outboxBacklog: Gauge<'state'>;
  readonly outboxOldestPendingAge: Gauge;
  readonly notificationsQueued: Gauge;
  readonly notificationDlqDepth: Gauge;
  readonly escrowLockedKobo: Gauge<'status'>;

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    @Inject(DELIVERY_LOG_REPOSITORY) private readonly deliveryLog: DeliveryLogRepository,
    @Inject(ESCROW_REPOSITORY) private readonly escrows: EscrowRepository,
    // Test seam: unit tests pass an isolated Registry; production uses the
    // default registry that the /metrics controller renders.
    @Optional() private readonly registry: Registry<PrometheusContentType> = register
  ) {
    this.outboxBacklog = this.gauge<'state'>({
      name: 'agric_outbox_backlog_records',
      help: 'Domain-event outbox rows by state (pending|dead_lettered)',
      labelNames: ['state'],
      collect: () => this.collectOutbox()
    });
    this.outboxOldestPendingAge = this.gauge({
      name: 'agric_outbox_oldest_pending_age_seconds',
      help: 'Age in seconds of the oldest unpublished, non-dead-lettered outbox row',
      collect: () => this.collectOutboxAge()
    });
    this.notificationsQueued = this.gauge({
      name: 'agric_notifications_queued',
      help: 'Notifications waiting for delivery',
      collect: () => this.collectNotifications()
    });
    this.notificationDlqDepth = this.gauge({
      name: 'agric_notification_dlq_depth',
      help: 'Delivery-log entries dead-lettered after exhausting retries',
      collect: () => this.collectDlqDepth()
    });
    this.escrowLockedKobo = this.gauge<'status'>({
      name: 'agric_escrow_locked_amount_kobo',
      help: 'Escrow funds still locked on the platform, by escrow status',
      labelNames: ['status'],
      collect: () => this.collectEscrow()
    });
  }

  private gauge<T extends string>(config: {
    name: string;
    help: string;
    labelNames?: T[];
    collect: () => Promise<void>;
  }): Gauge<T> {
    const existing = this.registry.getSingleMetric(config.name) as Gauge<T> | undefined;
    if (existing) {
      return existing;
    }
    const collect: CollectFunction<Gauge<T>> = async () => {
      try {
        await config.collect();
      } catch (error) {
        this.logger.warn(
          `operational metric collection failed for ${config.name}: ${(error as Error).message}`
        );
      }
    };
    return new Gauge({
      name: config.name,
      help: config.help,
      labelNames: config.labelNames ?? [],
      registers: [this.registry],
      collect
    });
  }

  private async collectOutbox(): Promise<void> {
    const records = await this.outbox.listRecords();
    this.outboxBacklog.set(
      { state: 'pending' },
      records.filter((record) => !record.publishedAt && !record.deadLetteredAt).length
    );
    this.outboxBacklog.set(
      { state: 'dead_lettered' },
      records.filter((record) => record.deadLetteredAt).length
    );
  }

  private async collectOutboxAge(now: Date = new Date()): Promise<void> {
    const records = await this.outbox.listRecords();
    const pending = records.filter((record) => !record.publishedAt && !record.deadLetteredAt);
    if (pending.length === 0) {
      this.outboxOldestPendingAge.set(0);
      return;
    }
    const oldest = Math.min(
      ...pending.map((record) => new Date(record.event.occurredAt).getTime())
    );
    this.outboxOldestPendingAge.set(Math.max(0, (now.getTime() - oldest) / 1000));
  }

  private async collectNotifications(): Promise<void> {
    this.notificationsQueued.set((await this.notifications.find({ status: 'queued' })).length);
  }

  private async collectDlqDepth(): Promise<void> {
    this.notificationDlqDepth.set(
      (await this.deliveryLog.list()).filter((entry) => entry.deadLetteredAt).length
    );
  }

  private async collectEscrow(): Promise<void> {
    for (const status of ESCROW_LOCKED_STATUSES) {
      const records = await this.escrows.find({ status });
      this.escrowLockedKobo.set(
        { status },
        records.reduce((sum, record) => sum + record.amountKobo, 0)
      );
    }
  }
}
