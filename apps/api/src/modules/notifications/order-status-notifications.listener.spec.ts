import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import { InMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryProcessedEventRepository } from '../../database/repositories/processed-event.repository.js';
import { OrderStatusNotificationsListener } from './order-status-notifications.listener.js';
import type { NotificationsService } from './notifications.service.js';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  id: 'order-1',
  listingId: 'listing-1',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  quantity: 10,
  totalNaira: 420_000,
  status: 'delivered',
  escrowRequired: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...overrides
});

describe('OrderStatusNotificationsListener (GAP-H05 partial)', () => {
  let events: DomainEventsService;
  let dedup: EventDedupService;
  let send: ReturnType<typeof vi.fn>;
  let preferencesFor: ReturnType<typeof vi.fn>;
  let listener: OrderStatusNotificationsListener;

  beforeEach(() => {
    events = new DomainEventsService(createInMemoryOutboxRepository());
    dedup = new EventDedupService(createInMemoryProcessedEventRepository());
    send = vi.fn().mockResolvedValue({ id: 'msg-1' });
    preferencesFor = vi.fn().mockResolvedValue([]);
    const notifications = { send, preferencesFor } as unknown as NotificationsService;
    listener = new OrderStatusNotificationsListener(
      events,
      notifications,
      new InMemoryOrderRepository([makeOrder()]),
      dedup
    );
    listener.onModuleInit();
  });

  const emitStatus = (to: string, eventId?: string) => {
    const event = events.build(
      'marketplace.order.status_changed',
      { orderId: 'order-1', from: 'in_fulfilment', to },
      'seller-1'
    );
    if (eventId) {
      event.id = eventId;
    }
    events.emit(event);
    return event;
  };

  it('notifies the buyer in_app when an order is delivered', async () => {
    emitStatus('delivered');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      userId: 'buyer-1',
      channel: 'in_app',
      title: 'Order delivered',
      body: expect.stringContaining('order-1')
    });
  });

  it('notifies the buyer when an order is completed', async () => {
    emitStatus('completed');
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ title: 'Order completed' });
  });

  it('ignores non-delivery-critical transitions', async () => {
    emitStatus('negotiating');
    emitStatus('deposit_paid');
    emitStatus('cancelled');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('sweeper re-drive of the same event id does not duplicate the notification', async () => {
    const event = emitStatus('delivered');
    events.emit(event); // re-drive
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a missing order is a handled skip (marked processed, never retried forever)', async () => {
    const event = events.build(
      'marketplace.order.status_changed',
      { orderId: 'order-missing', from: 'in_fulfilment', to: 'delivered' },
      'seller-1'
    );
    events.emit(event);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(await dedup.has('notifications-order-status', event.id)).toBe(true);
  });

  it('a buyer who disabled in_app is honoured (no channel substitution)', async () => {
    preferencesFor.mockResolvedValue([{ channel: 'in_app', enabled: false }]);
    const event = emitStatus('delivered');
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(await dedup.has('notifications-order-status', event.id)).toBe(true);
  });

  it('a failed send stays unrecorded so the outbox sweeper re-drives it', async () => {
    send.mockRejectedValueOnce(new Error('driver down'));
    const event = emitStatus('delivered');
    await flush();
    expect(await dedup.has('notifications-order-status', event.id)).toBe(false);
    // Re-drive succeeds and is recorded.
    events.emit(event);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(await dedup.has('notifications-order-status', event.id)).toBe(true);
  });
});
