import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import type { NotificationChannel, NotificationMessage, NotificationPreference } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import {
  DELIVERY_LOG_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  DeliveryLogEntry,
  DeliveryLogRepository
} from '../../database/repositories/delivery-log.repository.js';
import type { NotificationPreferenceRepository } from '../../database/repositories/notification-preference.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { SYNC_ENTITY_NOTIFICATION } from '../sync/sync-proof-entities.js';
import type { SyncVersioningService } from '../sync/sync-versioning.service.js';
import { DELIVERY_RETRY_BASE_MS } from './delivery-retry.service.js';

export type { DeliveryLogEntry };

export interface SendNotificationInput {
  userId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly events: DomainEventsService,
    private readonly integrations: IntegrationsService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly messages: NotificationRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(DELIVERY_LOG_REPOSITORY) private readonly deliveryLog: DeliveryLogRepository,
    // Wave SYNCSRV: sync version bumps on message writes (optional so bare
    // service constructions in tests keep working; additive + non-fatal).
    @Optional() private readonly syncVersioning?: SyncVersioningService
  ) {}

  async list(filter: {
    userId?: string;
    status?: NotificationMessage['status'];
  }): Promise<NotificationMessage[]> {
    return this.messages.find({ userId: filter.userId, status: filter.status });
  }

  async unreadCount(userId: string): Promise<number> {
    return this.messages.countUnread(userId);
  }

  /** Orchestrated send: honours preferences, routes via provider adapters. */
  async send(input: SendNotificationInput): Promise<NotificationMessage> {
    const preference = await this.preferences.find(input.userId, input.channel);
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
    await this.messages.create(message);
    await this.events.publish(
      'notification.delivery.requested',
      { notificationId: message.id, channel: input.channel },
      input.userId
    );

    const result = this.integrations.deliver(input.channel);
    // Delivery log + status flip commit as one unit. Failures schedule the
    // first retry (Wave P backoff); the sweeper picks them up when due.
    const at = new Date();
    const recorded = await this.messages.recordDelivery(
      message.id,
      result.delivered ? 'sent' : 'failed',
      {
        notificationId: message.id,
        result,
        at: at.toISOString(),
        attempt: 1,
        ...(result.delivered
          ? {}
          : { nextRetryAt: new Date(at.getTime() + DELIVERY_RETRY_BASE_MS).toISOString() })
      }
    );
    await this.syncVersioning?.recordChange({
      entity: SYNC_ENTITY_NOTIFICATION,
      entityId: recorded.id,
      ownerId: recorded.userId,
      actorId: input.userId
    });
    return recorded;
  }

  /** Single message (used for ownership checks before state changes). */
  async getMessage(id: string): Promise<NotificationMessage> {
    return this.messages.getById(id);
  }

  async markRead(id: string): Promise<NotificationMessage> {
    const updated = await this.messages.update(id, { status: 'read' });
    await this.syncVersioning?.recordChange({
      entity: SYNC_ENTITY_NOTIFICATION,
      entityId: updated.id,
      ownerId: updated.userId,
      actorId: updated.userId
    });
    return updated;
  }

  async preferencesFor(userId: string): Promise<NotificationPreference[]> {
    return this.preferences.listForUser(userId);
  }

  async setPreferences(
    userId: string,
    prefs: NotificationPreference[]
  ): Promise<NotificationPreference[]> {
    for (const pref of prefs) {
      await this.preferences.upsert({ ...pref, userId });
    }
    await this.events.publish(
      'notification.preferences.updated',
      { userId, channels: prefs.map((p) => `${p.channel}:${p.enabled}`) },
      userId
    );
    return this.preferencesFor(userId);
  }

  async deliveries(): Promise<DeliveryLogEntry[]> {
    return this.deliveryLog.list();
  }
}
