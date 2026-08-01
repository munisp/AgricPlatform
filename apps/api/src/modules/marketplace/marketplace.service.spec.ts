import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { MarketplaceService } from './marketplace.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  return {
    marketplace: new MarketplaceService(
      events,
      createInMemoryListingRepository(),
      createInMemoryOrderRepository(),
      createInMemoryReviewRepository()
    ),
    events
  };
}

// Seed order 'order-buyer-cassava' starts in 'confirmed' (buyer user-buyer, seller user-adamu).
describe('MarketplaceService order state machine', () => {
  it('walks the happy path with actor-scoped transitions', async () => {
    const { marketplace } = makeService();
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer)).status).toBe('deposit_paid');
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'in_fulfilment', seller)).status).toBe('in_fulfilment');
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'delivered', seller)).status).toBe('delivered');
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'completed', buyer)).status).toBe('completed');
  });

  it('rejects invalid transitions', async () => {
    const { marketplace } = makeService();
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'delivered', admin)).rejects.toThrowError(
      BadRequestException
    );
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'requested', admin)).rejects.toThrowError(
      /Invalid order transition/
    );
  });

  it('rejects transitions from terminal states', async () => {
    const { marketplace } = makeService();
    await marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', buyer);
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'confirmed', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('enforces the entitled party per transition', async () => {
    const { marketplace } = makeService();
    // Only the buyer pays the deposit.
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', seller)).rejects.toThrowError(
      ForbiddenException
    );
    // Unrelated users cannot drive the order at all.
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', outsider)).rejects.toThrowError(
      ForbiddenException
    );
    // Admin override still respects valid transitions.
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', admin)).status).toBe('deposit_paid');
    // Dispute resolution is admin-mediated.
    await marketplace.setOrderStatus('order-buyer-cassava', 'disputed', buyer);
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', buyer)).rejects.toThrowError(
      ForbiddenException
    );
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', admin)).status).toBe('cancelled');
  });

  it('treats re-sending the current status as an idempotent replay', async () => {
    const { marketplace, events } = makeService();
    expect((await marketplace.setOrderStatus('order-buyer-cassava', 'confirmed', buyer)).status).toBe('confirmed');
    expect((await events.listOutbox()).filter((e) => e.name === 'marketplace.order.status_changed')).toHaveLength(0);

    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer);
    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer);
    expect((await events.listOutbox()).filter((e) => e.name === 'marketplace.order.status_changed')).toHaveLength(1);
  });

  it('keeps review gating on delivered/completed orders', async () => {
    const { marketplace } = makeService();
    await expect(marketplace.reviewOrder('order-buyer-cassava', 'user-buyer', 5)).rejects.toThrowError(
      BadRequestException
    );
  });
});
