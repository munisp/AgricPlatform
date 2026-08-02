import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DELIVERY_LOG_REPOSITORY,
  NOTIFICATION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  DeliveryLogEntry,
  DeliveryLogRepository
} from '../../database/repositories/delivery-log.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';

/** Max delivery attempts before a notification is dead-lettered. */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** First retry delay; doubles each attempt (exponential backoff). */
export const DELIVERY_RETRY_BASE_MS = 60_000;

export interface DeliveryQueueEntry {
  notificationId: string;
  attempt: number;
  lastResult: DeliveryLogEntry['result'];
  lastAttemptAt: string;
  nextRetryAt?: string;
  deadLetteredAt?: string;
}

export interface SweepResult {
  retried: number;
  delivered: number;
  deadLettered: number;
  /** Entries not yet due (backoff window still open). */
  deferred: number;
}

/**
 * Notification delivery retries + DLQ (Wave P). Failed deliveries are
 * retried with exponential backoff (base 60s, doubling, capped by max
 * attempts); exhausted entries are marked dead-lettered for operator
 * review. The sweeper is invoked via POST /notifications/deliveries/sweep —
 * an external scheduler (cron/systemd timer) should call that endpoint;
 * the API itself starts no timers so worker cadence stays observable.
 */
@Injectable()
export class DeliveryRetryService {
  private readonly logger = new Logger(DeliveryRetryService.name);

  constructor(
    private readonly integrations: IntegrationsService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly messages: NotificationRepository,
    @Inject(DELIVERY_LOG_REPOSITORY) private readonly deliveryLog: DeliveryLogRepository
  ) {}

  /** Backoff for the NEXT attempt after `attempt` failed attempts. */
  backoffMs(attempt: number): number {
    return DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  }

  /** Latest log entry per notification (the log is append-only). */
  private latestByNotification(entries: DeliveryLogEntry[]): Map<string, DeliveryLogEntry> {
    const latest = new Map<string, DeliveryLogEntry>();
    for (const entry of entries) {
      latest.set(entry.notificationId, entry);
    }
    return latest;
  }

  /** Dead letters: latest entry dead-lettered. */
  async listDeadLetters(): Promise<DeliveryQueueEntry[]> {
    const latest = this.latestByNotification(await this.deliveryLog.list());
    return [...latest.values()]
      .filter((entry) => entry.deadLetteredAt)
      .map((entry) => this.toQueueEntry(entry));
  }

  /**
   * One sweeper pass: retries every failed, non-dead-lettered notification
   * whose backoff window has elapsed. Idempotent; safe to invoke often.
   */
  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const latest = this.latestByNotification(await this.deliveryLog.list());
    const result: SweepResult = { retried: 0, delivered: 0, deadLettered: 0, deferred: 0 };
    for (const entry of latest.values()) {
      if (entry.result.delivered || entry.deadLetteredAt) {
        continue;
      }
      if (entry.nextRetryAt && new Date(entry.nextRetryAt).getTime() > now.getTime()) {
        result.deferred += 1;
        continue;
      }
      result.retried += 1;
      const outcome = await this.attempt(entry.notificationId, (entry.attempt ?? 1) + 1, now);
      if (outcome === 'delivered') {
        result.delivered += 1;
      } else if (outcome === 'dead_lettered') {
        result.deadLettered += 1;
      }
    }
    return result;
  }

  /**
   * Manual retry of a dead-lettered (or failed) notification: delivers now,
   * restarting the attempt series (operator override of the backoff).
   */
  async retryNow(notificationId: string): Promise<DeliveryQueueEntry> {
    const entries = await this.deliveryLog.list({ notificationId });
    const latest = entries[entries.length - 1];
    if (!latest) {
      throw new NotFoundException(`No delivery attempts recorded for notification ${notificationId}`);
    }
    const message = await this.messages.getById(notificationId);
    const result = this.integrations.deliver(message.channel);
    const attempt = (latest.attempt ?? 1) + 1;
    const entry = this.buildEntry(notificationId, result, attempt);
    await this.messages.recordDelivery(
      notificationId,
      result.delivered ? 'sent' : 'failed',
      entry
    );
    return this.toQueueEntry(entry);
  }

  /** One delivery attempt; records backoff or dead-letter state. */
  private async attempt(
    notificationId: string,
    attempt: number,
    now: Date
  ): Promise<'delivered' | 'retry_scheduled' | 'dead_lettered'> {
    const message = await this.messages.getById(notificationId);
    const result = this.integrations.deliver(message.channel);
    const entry = this.buildEntry(notificationId, result, attempt, now);
    await this.messages.recordDelivery(notificationId, result.delivered ? 'sent' : 'failed', entry);
    if (result.delivered) {
      return 'delivered';
    }
    if (entry.deadLetteredAt) {
      this.logger.warn(`notification ${notificationId} dead-lettered after ${attempt} attempts`);
      return 'dead_lettered';
    }
    return 'retry_scheduled';
  }

  private buildEntry(
    notificationId: string,
    result: DeliveryLogEntry['result'],
    attempt: number,
    now: Date = new Date()
  ): DeliveryLogEntry {
    if (result.delivered) {
      return { notificationId, result, at: now.toISOString(), attempt };
    }
    if (attempt >= DELIVERY_MAX_ATTEMPTS) {
      return { notificationId, result, at: now.toISOString(), attempt, deadLetteredAt: now.toISOString() };
    }
    return {
      notificationId,
      result,
      at: now.toISOString(),
      attempt,
      nextRetryAt: new Date(now.getTime() + this.backoffMs(attempt)).toISOString()
    };
  }

  private toQueueEntry(entry: DeliveryLogEntry): DeliveryQueueEntry {
    return {
      notificationId: entry.notificationId,
      attempt: entry.attempt ?? 1,
      lastResult: entry.result,
      lastAttemptAt: entry.at,
      ...(entry.nextRetryAt ? { nextRetryAt: entry.nextRetryAt } : {}),
      ...(entry.deadLetteredAt ? { deadLetteredAt: entry.deadLetteredAt } : {})
    };
  }
}
