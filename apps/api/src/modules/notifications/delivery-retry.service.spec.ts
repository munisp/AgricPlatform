import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationMessage } from '@agric-platform/shared';
import { createInMemoryDeliveryLogRepository } from '../../database/repositories/delivery-log.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import {
  DELIVERY_MAX_ATTEMPTS,
  DELIVERY_RETRY_BASE_MS,
  DeliveryRetryService
} from './delivery-retry.service.js';

function build(delivered: boolean) {
  const deliveryLog = createInMemoryDeliveryLogRepository();
  const messages = new InMemoryNotificationRepository([], deliveryLog);
  const integrations = {
    deliver: vi.fn(() => ({
      delivered,
      provider: 'termii',
      driver: 'stub' as const,
      providerRef: 'stub-1',
      note: delivered ? 'ok' : 'provider unreachable'
    }))
  } as unknown as IntegrationsService;
  const service = new DeliveryRetryService(integrations, messages, deliveryLog);
  return { service, messages, deliveryLog, integrations };
}

async function seedFailed(
  deps: ReturnType<typeof build>,
  id: string,
  attempt: number,
  nextRetryAt?: string,
  deadLetteredAt?: string
): Promise<NotificationMessage> {
  const message: NotificationMessage = {
    id,
    userId: 'user-aisha',
    channel: 'sms',
    title: 'Alert',
    body: 'Body',
    status: 'failed',
    createdAt: new Date().toISOString()
  };
  await deps.messages.create(message);
  await deps.deliveryLog.append({
    notificationId: id,
    result: {
      delivered: false,
      provider: 'termii',
      driver: 'stub',
      providerRef: 'stub-0',
      note: 'provider unreachable'
    },
    at: new Date().toISOString(),
    attempt,
    ...(nextRetryAt ? { nextRetryAt } : {}),
    ...(deadLetteredAt ? { deadLetteredAt } : {})
  });
  return message;
}

describe('DeliveryRetryService', () => {
  it('backoff doubles per attempt from the base delay', () => {
    const { service } = build(false);
    expect(service.backoffMs(1)).toBe(DELIVERY_RETRY_BASE_MS);
    expect(service.backoffMs(2)).toBe(DELIVERY_RETRY_BASE_MS * 2);
    expect(service.backoffMs(3)).toBe(DELIVERY_RETRY_BASE_MS * 4);
  });

  it('defers entries whose backoff window has not elapsed', async () => {
    const deps = build(true);
    await seedFailed(deps, 'n1', 1, new Date(Date.now() + 60_000).toISOString());
    const result = await deps.service.sweep();
    expect(result).toEqual({ retried: 0, delivered: 0, deadLettered: 0, deferred: 1 });
  });

  it('retries due failures and marks them sent on success', async () => {
    const deps = build(true);
    await seedFailed(deps, 'n1', 1, new Date(Date.now() - 1000).toISOString());
    const result = await deps.service.sweep();
    expect(result.retried).toBe(1);
    expect(result.delivered).toBe(1);
    expect((await deps.messages.getById('n1')).status).toBe('sent');
    const entries = await deps.deliveryLog.list({ notificationId: 'n1' });
    expect(entries.at(-1)?.attempt).toBe(2);
    expect(entries.at(-1)?.result.delivered).toBe(true);
  });

  it('schedules the next retry with exponential backoff on repeated failure', async () => {
    const deps = build(false);
    await seedFailed(deps, 'n1', 2, new Date(Date.now() - 1000).toISOString());
    const before = Date.now();
    const result = await deps.service.sweep();
    expect(result.retried).toBe(1);
    expect(result.deadLettered).toBe(0);
    const entries = await deps.deliveryLog.list({ notificationId: 'n1' });
    const latest = entries.at(-1)!;
    expect(latest.attempt).toBe(3);
    const eta = new Date(latest.nextRetryAt!).getTime() - before;
    // attempt 3 failed → next delay is base * 2^(3-1).
    expect(eta).toBeGreaterThanOrEqual(DELIVERY_RETRY_BASE_MS * 4 - 1000);
    expect(eta).toBeLessThanOrEqual(DELIVERY_RETRY_BASE_MS * 4 + 5000);
  });

  it('dead-letters after max attempts and stops retrying', async () => {
    const deps = build(false);
    await seedFailed(deps, 'n1', DELIVERY_MAX_ATTEMPTS - 1, new Date(Date.now() - 1000).toISOString());
    const result = await deps.service.sweep();
    expect(result.deadLettered).toBe(1);
    const entries = await deps.deliveryLog.list({ notificationId: 'n1' });
    expect(entries.at(-1)?.deadLetteredAt).toBeTruthy();

    // A second sweep ignores the dead letter.
    const again = await deps.service.sweep();
    expect(again).toEqual({ retried: 0, delivered: 0, deadLettered: 0, deferred: 0 });
  });

  it('lists dead letters for the admin queue', async () => {
    const deps = build(false);
    await seedFailed(deps, 'n1', DELIVERY_MAX_ATTEMPTS, undefined, new Date().toISOString());
    await seedFailed(deps, 'n2', 1, new Date(Date.now() + 60_000).toISOString());
    const dead = await deps.service.listDeadLetters();
    expect(dead.map((entry) => entry.notificationId)).toEqual(['n1']);
    expect(dead[0].attempt).toBe(DELIVERY_MAX_ATTEMPTS);
  });

  it('manual retry delivers immediately and clears dead-letter state', async () => {
    const deps = build(true);
    await seedFailed(deps, 'n1', DELIVERY_MAX_ATTEMPTS, undefined, new Date().toISOString());
    const retried = await deps.service.retryNow('n1');
    expect(retried.lastResult.delivered).toBe(true);
    expect(retried.deadLetteredAt).toBeUndefined();
    expect(await deps.service.listDeadLetters()).toEqual([]);
    expect((await deps.messages.getById('n1')).status).toBe('sent');
  });

  it('manual retry of an unknown notification 404s', async () => {
    const { service } = build(true);
    await expect(service.retryNow('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips notifications whose latest attempt already succeeded', async () => {
    const deps = build(true);
    const message: NotificationMessage = {
      id: 'n9',
      userId: 'user-aisha',
      channel: 'sms',
      title: 't',
      body: 'b',
      status: 'sent',
      createdAt: new Date().toISOString()
    };
    await deps.messages.create(message);
    await deps.deliveryLog.append({
      notificationId: 'n9',
      result: { delivered: true, provider: 'termii', driver: 'stub', providerRef: 'x', note: 'ok' },
      at: new Date().toISOString(),
      attempt: 1
    });
    expect((await deps.service.sweep()).retried).toBe(0);
  });
});
