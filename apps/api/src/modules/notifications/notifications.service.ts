import { BadRequestException, Injectable } from '@nestjs/common';
import type { NotificationChannel, NotificationMessage, NotificationPreference } from '@agric-platform/shared';
import { InMemoryRepository, newId } from '../../common/in-memory.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  seedNotificationMessages,
  seedNotificationPreferences
} from '../../database/seed-data.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { DeliveryResult } from '../integrations/adapters.js';

export interface SendNotificationInput {
  userId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
}

export interface DeliveryLogEntry {
  notificationId: string;
  result: DeliveryResult;
  at: string;
}

@Injectable()
export class NotificationsService {
  private readonly messages = new InMemoryRepository<NotificationMessage>(seedNotificationMessages);
  private readonly preferences: InMemoryRepository<NotificationPreference & { id: string }>;
  private readonly deliveryLog: DeliveryLogEntry[] = [];

  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService
  ) {
    this.preferences = new InMemoryRepository(
      seedNotificationPreferences.map((p) => ({ ...p, id: `${p.userId}:${p.channel}` }))
    );
  }

  list(filter: { userId?: string; status?: NotificationMessage['status'] }): NotificationMessage[] {
    return this.messages.find(
      (m) => (!filter.userId || m.userId === filter.userId) && (!filter.status || m.status === filter.status)
    );
  }

  unreadCount(userId: string): number {
    return this.messages.count((m) => m.userId === userId && m.status !== 'read');
  }

  /** Orchestrated send: honours preferences, routes via provider adapters. */
  send(input: SendNotificationInput): NotificationMessage {
    const preference = this.preferences.findById(`${input.userId}:${input.channel}`);
    if (preference && !preference.enabled) {
      throw new BadRequestException(
        `Channel '${input.channel}' is disabled in this user's notification preferences`
      );
    }
    const message: NotificationMessage = {
      id: newId('notification'),
      userId: input.userId,
      channel: input.channel,
      title: input.title,
      body: input.body,
      status: 'queued',
      createdAt: new Date().toISOString()
    };
    this.messages.create(message);
    this.events.publish(
      'notification.delivery.requested',
      { notificationId: message.id, channel: input.channel },
      input.userId
    );

    const result = this.integrations.deliver(input.channel);
    this.deliveryLog.push({ notificationId: message.id, result, at: new Date().toISOString() });
    return this.messages.update(message.id, { status: result.delivered ? 'sent' : 'failed' });
  }

  /** Single message (used for ownership checks before state changes). */
  getMessage(id: string): NotificationMessage {
    return this.messages.getById(id);
  }

  markRead(id: string): NotificationMessage {
    return this.messages.update(id, { status: 'read' });
  }

  preferencesFor(userId: string): NotificationPreference[] {
    return this.preferences
      .find((p) => p.userId === userId)
      .map(({ id: _id, ...preference }) => preference);
  }

  setPreferences(userId: string, prefs: NotificationPreference[]): NotificationPreference[] {
    for (const pref of prefs) {
      const id = `${pref.userId}:${pref.channel}`;
      const stored = { ...pref, userId, id };
      if (this.preferences.findById(id)) {
        this.preferences.update(id, stored);
      } else {
        this.preferences.create(stored);
      }
    }
    this.events.publish(
      'notification.preferences.updated',
      { userId, channels: prefs.map((p) => `${p.channel}:${p.enabled}`) },
      userId
    );
    return this.preferencesFor(userId);
  }

  deliveries(): DeliveryLogEntry[] {
    return [...this.deliveryLog];
  }
}
