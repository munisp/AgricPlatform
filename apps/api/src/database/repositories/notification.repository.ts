import type { NotificationMessage } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedNotificationMessages } from '../seed-data.js';
import type { DeliveryLogEntry, DeliveryLogRepository } from './delivery-log.repository.js';

export interface NotificationCriteria {
  userId?: string;
  status?: NotificationMessage['status'];
}

export interface NotificationRepository
  extends AsyncRepository<NotificationMessage, NotificationCriteria> {
  countUnread(userId: string): Promise<number>;
  /**
   * Delivery log append + message status update as one atomic unit
   * (notifications.delivery_logs + notifications.notifications).
   */
  recordDelivery(
    id: string,
    status: NotificationMessage['status'],
    entry: DeliveryLogEntry
  ): Promise<NotificationMessage>;
}

export function notificationMatcher(
  criteria: NotificationCriteria
): (message: NotificationMessage) => boolean {
  return (message) =>
    (!criteria.userId || message.userId === criteria.userId) &&
    (!criteria.status || message.status === criteria.status);
}

export class InMemoryNotificationRepository
  extends InMemoryRepository<NotificationMessage, NotificationCriteria>
  implements NotificationRepository
{
  constructor(
    seed: readonly NotificationMessage[] = [],
    private readonly deliveryLog?: DeliveryLogRepository
  ) {
    super(seed, notificationMatcher);
  }

  async countUnread(userId: string): Promise<number> {
    return (await this.find({ userId })).filter((message) => message.status !== 'read').length;
  }

  async recordDelivery(
    id: string,
    status: NotificationMessage['status'],
    entry: DeliveryLogEntry
  ): Promise<NotificationMessage> {
    await this.deliveryLog?.append(entry);
    return this.update(id, { status });
  }
}

export function createInMemoryNotificationRepository(
  deliveryLog?: DeliveryLogRepository
): InMemoryNotificationRepository {
  return new InMemoryNotificationRepository(seedNotificationMessages, deliveryLog);
}
