import { Registry } from 'prom-client';
import type { EscrowRecord, NotificationMessage } from '@agric-platform/shared';
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../core/domain-events.service.js';
import { InMemoryDeliveryLogRepository } from '../../database/repositories/delivery-log.repository.js';
import { InMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { InMemoryNotificationRepository } from '../../database/repositories/notification.repository.js';
import { InMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { OperationalMetricsService } from './operational-metrics.service.js';

function event(id: string, occurredAt: string): DomainEvent {
  return { id, name: 'test.entity.created', payload: {}, occurredAt };
}

function notification(id: string, status: NotificationMessage['status']): NotificationMessage {
  return {
    id,
    userId: 'user-aisha',
    channel: 'sms',
    title: 't',
    body: 'b',
    status,
    createdAt: '2025-01-01T00:00:00.000Z'
  };
}

function escrow(id: string, status: EscrowRecord['status'], amountKobo: number): EscrowRecord {
  return {
    id,
    orderId: `order-${id}`,
    amountKobo,
    status,
    heldAt: '2025-01-01T00:00:00.000Z'
  };
}

function makeService(options: {
  outbox?: InMemoryOutboxRepository;
  notifications?: InMemoryNotificationRepository;
  deliveryLog?: InMemoryDeliveryLogRepository;
  escrows?: InMemoryEscrowRepository;
}): { service: OperationalMetricsService; scrape: () => Promise<string> } {
  // Isolated registry per test so collectors always bind to this test's repos.
  const registry = new Registry();
  const service = new OperationalMetricsService(
    options.outbox ?? new InMemoryOutboxRepository(),
    options.notifications ?? new InMemoryNotificationRepository(),
    options.deliveryLog ?? new InMemoryDeliveryLogRepository(),
    options.escrows ?? new InMemoryEscrowRepository(),
    registry
  );
  return { service, scrape: () => registry.metrics() };
}

describe('OperationalMetricsService', () => {
  it('reports outbox backlog by state', async () => {
    const outbox = new InMemoryOutboxRepository();
    await outbox.append(event('e1', '2025-01-01T00:00:00.000Z'));
    await outbox.append(event('e2', '2025-01-01T00:00:00.000Z'));
    await outbox.markDeadLetter('e2', '2025-01-02T00:00:00.000Z');
    const { scrape } = makeService({ outbox });

    const text = await scrape();
    expect(text).toContain('agric_outbox_backlog_records{state="pending"} 1');
    expect(text).toContain('agric_outbox_backlog_records{state="dead_lettered"} 1');
  });

  it('reports the age of the oldest pending outbox row', async () => {
    const outbox = new InMemoryOutboxRepository();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await outbox.append(event('old', tenMinutesAgo));
    const { scrape } = makeService({ outbox });

    const text = await scrape();
    const match = text.match(/agric_outbox_oldest_pending_age_seconds (\d+(?:\.\d+)?)/);
    expect(match).toBeTruthy();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(600 - 5);
  });

  it('reports zero age when the outbox has no pending rows', async () => {
    const outbox = new InMemoryOutboxRepository();
    await outbox.append(event('done', '2025-01-01T00:00:00.000Z'));
    await outbox.markPublished('done', '2025-01-01T00:00:01.000Z');
    const { service, scrape } = makeService({ outbox });

    await scrape();
    const value = await service.outboxOldestPendingAge.get();
    expect(value.values[0]?.value).toBe(0);
  });

  it('reports queued notifications and DLQ depth', async () => {
    const notifications = new InMemoryNotificationRepository([
      notification('n1', 'queued'),
      notification('n2', 'queued'),
      notification('n3', 'sent')
    ]);
    const deliveryLog = new InMemoryDeliveryLogRepository();
    await deliveryLog.append({ notificationId: 'n1', result: 'failed', at: '2025-01-01T00:00:00.000Z' });
    await deliveryLog.append({
      notificationId: 'n3',
      result: 'failed',
      at: '2025-01-01T00:05:00.000Z',
      deadLetteredAt: '2025-01-01T00:05:00.000Z'
    });
    const { scrape } = makeService({ notifications, deliveryLog });

    const text = await scrape();
    expect(text).toContain('agric_notifications_queued 2');
    expect(text).toContain('agric_notification_dlq_depth 1');
  });

  it('sums locked escrow amounts per status and ignores resolved escrows', async () => {
    const escrows = new InMemoryEscrowRepository([
      escrow('e1', 'held', 100_000),
      escrow('e2', 'held', 50_000),
      escrow('e3', 'disputed', 25_000),
      escrow('e4', 'released', 999_000)
    ]);
    const { scrape } = makeService({ escrows });

    const text = await scrape();
    expect(text).toContain('agric_escrow_locked_amount_kobo{status="held"} 150000');
    expect(text).toContain('agric_escrow_locked_amount_kobo{status="disputed"} 25000');
    expect(text).not.toContain('status="released"');
  });

  it('keeps the previous reading when a collector fails (scrape must not break)', async () => {
    const outbox = new InMemoryOutboxRepository();
    await outbox.append(event('e1', '2025-01-01T00:00:00.000Z'));
    const { scrape } = makeService({ outbox });
    await scrape(); // establishes pending=1

    const original = outbox.listRecords.bind(outbox);
    outbox.listRecords = async () => {
      throw new Error('database unreachable');
    };
    const text = await scrape(); // must not reject
    expect(text).toContain('agric_outbox_backlog_records{state="pending"} 1');

    // Restore and confirm the collector recovers on the next scrape.
    outbox.listRecords = original;
    await outbox.markPublished('e1', '2025-01-01T00:00:01.000Z');
    const recovered = await scrape();
    expect(recovered).toContain('agric_outbox_backlog_records{state="pending"} 0');
  });
});
