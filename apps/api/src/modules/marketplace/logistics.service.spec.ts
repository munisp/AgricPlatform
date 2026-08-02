import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryShipmentRepository } from '../../database/repositories/shipment.repository.js';
import { EscrowService } from './escrow.service.js';
import { LogisticsService } from './logistics.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };

// Seed order 'order-buyer-cassava' is 'confirmed' (buyer user-buyer, seller user-adamu).
function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const orders = createInMemoryOrderRepository();
  const escrow = new EscrowService(events, orders, createInMemoryEscrowRepository());
  const service = new LogisticsService(events, createInMemoryShipmentRepository(), orders, escrow);
  return { service, escrow, events };
}

describe('LogisticsService', () => {
  it('schedules one shipment per order with carrier/tracking fields', async () => {
    makeService();
    const shipment = await service.schedulePickup(
      'order-buyer-cassava',
      { carrier: 'GIG Logistics', trackingReference: 'GIG-123', scheduledPickupAt: '2026-08-01T09:00:00.000Z' },
      seller
    );
    expect(shipment.status).toBe('pickup_scheduled');
    expect(shipment.carrier).toBe('GIG Logistics');
    // Replay returns the same shipment.
    const replay = await service.schedulePickup('order-buyer-cassava', {}, seller);
    expect(replay.id).toBe(shipment.id);
  });

  it('restricts scheduling to the seller (or admin)', async () => {
    makeService();
    await expect(service.schedulePickup('order-buyer-cassava', {}, buyer)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(
      service.schedulePickup('order-buyer-cassava', {}, admin)
    ).resolves.toMatchObject({ status: 'pickup_scheduled' });
  });

  it('walks pickup → transit → delivery → confirmation and releases escrow', async () => {
    const { service, escrow } = makeService();
    await escrow.holdForOrder('order-buyer-cassava', buyer.id);
    const shipment = await service.schedulePickup('order-buyer-cassava', {}, seller);
    expect((await service.transition(shipment.id, 'in_transit', seller)).status).toBe('in_transit');
    expect((await service.transition(shipment.id, 'delivered', seller)).status).toBe('delivered');
    const confirmed = await service.transition(shipment.id, 'confirmed', buyer);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toBeDefined();
    // Delivery confirmation released the escrow.
    expect((await escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('released');
  });

  it('rejects illegal transitions and enforces the entitled party', async () => {
    makeService();
    const shipment = await service.schedulePickup('order-buyer-cassava', {}, seller);
    await expect(service.transition(shipment.id, 'delivered', admin)).rejects.toThrowError(
      /Invalid shipment transition/
    );
    await expect(service.transition(shipment.id, 'in_transit', buyer)).rejects.toThrowError(
      ForbiddenException
    );
    await service.transition(shipment.id, 'in_transit', seller);
    // Only the buyer confirms delivery.
    await expect(service.transition(shipment.id, 'confirmed', seller)).rejects.toThrowError(
      /Invalid shipment transition/
    );
    await service.transition(shipment.id, 'delivered', seller);
    await expect(service.transition(shipment.id, 'confirmed', seller)).rejects.toThrowError(
      ForbiddenException
    );
  });

  it('supports the failed → reschedule path with a failure reason', async () => {
    makeService();
    const shipment = await service.schedulePickup('order-buyer-cassava', {}, seller);
    await service.transition(shipment.id, 'in_transit', seller);
    const failed = await service.transition(shipment.id, 'failed', seller, 'truck breakdown');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('truck breakdown');
    const rescheduled = await service.transition(shipment.id, 'pickup_scheduled', seller);
    expect(rescheduled.status).toBe('pickup_scheduled');
    expect(rescheduled.failureReason).toBeUndefined();
    // Terminal confirmed state rejects further movement.
    await service.transition(shipment.id, 'in_transit', seller);
    await service.transition(shipment.id, 'delivered', seller);
    await service.transition(shipment.id, 'confirmed', buyer);
    await expect(service.transition(shipment.id, 'failed', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('refuses to schedule for orders that are not yet confirmed', async () => {
    makeService();
    const orders = createInMemoryOrderRepository();
    await orders.update('order-buyer-cassava', { status: 'requested' });
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const escrow = new EscrowService(events, orders, createInMemoryEscrowRepository());
    const early = new LogisticsService(events, createInMemoryShipmentRepository(), orders, escrow);
    await expect(early.schedulePickup('order-buyer-cassava', {}, seller)).rejects.toThrowError(
      BadRequestException
    );
  });
});
