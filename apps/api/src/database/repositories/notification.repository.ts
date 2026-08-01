import type { NotificationMessage } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedNotificationMessages } from '../seed-data.js';

export interface NotificationCriteria {
  userId?: string;
  status?: NotificationMessage['status'];
}

export interface NotificationRepository
  extends AsyncRepository<NotificationMessage, NotificationCriteria> {
  countUnread(userId: string): Promise<number>;
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
  constructor(seed: readonly NotificationMessage[] = []) {
    super(seed, notificationMatcher);
  }

  async countUnread(userId: string): Promise<number> {
    return (await this.find({ userId })).filter((message) => message.status !== 'read').length;
  }
}

export function createInMemoryNotificationRepository(): InMemoryNotificationRepository {
  return new InMemoryNotificationRepository(seedNotificationMessages);
}
