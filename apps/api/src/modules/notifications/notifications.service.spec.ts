import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDeliveryLogRepository } from '../../database/repositories/delivery-log.repository.js';
import { createInMemoryNotificationPreferenceRepository } from '../../database/repositories/notification-preference.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { NotificationsService } from './notifications.service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function build(integrations: IntegrationsService) {
  const deliveryLog = createInMemoryDeliveryLogRepository();
  const messages = new InMemoryNotificationRepository([], deliveryLog);
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new NotificationsService(
    events,
    integrations,
    messages,
    createInMemoryNotificationPreferenceRepository(),
    deliveryLog
  );
  return { service, messages, deliveryLog, integrations };
}

describe('NotificationsService delivery honesty (wave: stub never fabricates sent)', () => {
  it('stub driver: a sent request is NOT marked sent and is scheduled for retry', async () => {
    const { service, deliveryLog } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'sms',
      title: 'Alert',
      body: 'Body'
    });
    expect(message.status).not.toBe('sent');
    expect(message.status).toBe('failed');
    const entries = await deliveryLog.list({ notificationId: message.id });
    expect(entries).toHaveLength(1);
    expect(entries[0].result.delivered).toBe(false);
    expect(entries[0].result.driver).toBe('stub');
    expect(entries[0].nextRetryAt).toBeTruthy();
  });

  it('in_app channel: the persisted inbox record is an honest delivery', async () => {
    const { service } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Hello'
    });
    expect(message.status).toBe('sent');
  });

  it('configured-live driver: the provider is invoked and delivery is marked sent', async () => {
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message_id: 'live-9' }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'sms',
      title: 'Alert',
      body: 'Body'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(message.status).toBe('sent');
  });

  it('configured-live driver failure: the message is never marked sent', async () => {
    vi.stubEnv('SMS_DRIVER', 'production');
    vi.stubEnv('TERMII_API_KEY', 'key');
    vi.stubEnv('TERMII_SENDER_ID', 'AgricNG');
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const { service, messages } = build(new IntegrationsService());
    await expect(
      service.send({ userId: 'user-aisha', channel: 'sms', title: 'Alert', body: 'Body' })
    ).rejects.toThrow();
    const stored = await messages.find({ userId: 'user-aisha' });
    expect(stored).toHaveLength(1);
    expect(stored[0].status).not.toBe('sent');
  });
});

describe('NotificationsService persistence stamps (GAP-M17)', () => {
  it('populates a deterministic idempotency_key from the message fields', async () => {
    const { service } = build(new IntegrationsService());
    const first = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Hello'
    });
    const second = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Hello'
    });
    expect(first.idempotencyKey).toBeTruthy();
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const different = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Different body'
    });
    expect(different.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('stamps sent_at when the delivery records status sent', async () => {
    const { service, messages } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Hello'
    });
    expect(message.sentAt).toBeTruthy();
    const stored = await messages.getById(message.id);
    expect(stored.sentAt).toBe(message.sentAt);
  });

  it('does not stamp sent_at when the delivery is not honest (stub failure)', async () => {
    const { service } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'sms',
      title: 'Alert',
      body: 'Body'
    });
    expect(message.status).toBe('failed');
    expect(message.sentAt).toBeUndefined();
  });

  it('stamps read_at on mark-read', async () => {
    const { service } = build(new IntegrationsService());
    const message = await service.send({
      userId: 'user-aisha',
      channel: 'in_app',
      title: 'Welcome',
      body: 'Hello'
    });
    expect(message.readAt).toBeUndefined();
    const read = await service.markRead(message.id);
    expect(read.status).toBe('read');
    expect(read.readAt).toBeTruthy();
  });
});
