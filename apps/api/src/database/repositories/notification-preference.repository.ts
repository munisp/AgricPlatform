import type { NotificationChannel, NotificationPreference } from '@agric-platform/shared';
import { seedNotificationPreferences } from '../seed-data.js';

/**
 * Notification preference port keyed by the composite (user_id, channel)
 * (notifications.user_preferences). No surrogate id in the API contract.
 */
export interface NotificationPreferenceRepository {
  listForUser(userId: string): Promise<NotificationPreference[]>;
  find(userId: string, channel: NotificationChannel): Promise<NotificationPreference | undefined>;
  upsert(preference: NotificationPreference): Promise<NotificationPreference>;
}

export class InMemoryNotificationPreferenceRepository
  implements NotificationPreferenceRepository
{
  private readonly items = new Map<string, NotificationPreference>();

  constructor(seed: readonly NotificationPreference[] = []) {
    for (const preference of seed) {
      this.items.set(`${preference.userId}:${preference.channel}`, { ...preference });
    }
  }

  async listForUser(userId: string): Promise<NotificationPreference[]> {
    return [...this.items.values()].filter((preference) => preference.userId === userId);
  }

  async find(
    userId: string,
    channel: NotificationChannel
  ): Promise<NotificationPreference | undefined> {
    return this.items.get(`${userId}:${channel}`);
  }

  async upsert(preference: NotificationPreference): Promise<NotificationPreference> {
    this.items.set(`${preference.userId}:${preference.channel}`, preference);
    return preference;
  }
}

export function createInMemoryNotificationPreferenceRepository(): InMemoryNotificationPreferenceRepository {
  return new InMemoryNotificationPreferenceRepository(seedNotificationPreferences);
}
