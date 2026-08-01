import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { MarketplaceService } from './marketplace.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeService() {
  const events = new DomainEventsService();
  return { marketplace: new MarketplaceService(events), events };
}

// Seed order 'order-buyer-cassava' starts in 'confirmed' (buyer user-buyer, seller user-adamu).
describe('MarketplaceService order state machine', () => {
  it('walks the happy path with actor-scoped transitions', () => {
    const { marketplace } = makeService();
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer).status).toBe('deposit_paid');
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'in_fulfilment', seller).status).toBe('in_fulfilment');
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'delivered', seller).status).toBe('delivered');
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'completed', buyer).status).toBe('completed');
  });

  it('rejects invalid transitions', () => {
    const { marketplace } = makeService();
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'delivered', admin)).toThrowError(
      BadRequestException
    );
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'requested', admin)).toThrowError(
      /Invalid order transition/
    );
  });

  it('rejects transitions from terminal states', () => {
    const { marketplace } = makeService();
    marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', buyer);
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'confirmed', admin)).toThrowError(
      BadRequestException
    );
  });

  it('enforces the entitled party per transition', () => {
    const { marketplace } = makeService();
    // Only the buyer pays the deposit.
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', seller)).toThrowError(
      ForbiddenException
    );
    // Unrelated users cannot drive the order at all.
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', outsider)).toThrowError(
      ForbiddenException
    );
    // Admin override still respects valid transitions.
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', admin).status).toBe('deposit_paid');
    // Dispute resolution is admin-mediated.
    marketplace.setOrderStatus('order-buyer-cassava', 'disputed', buyer);
    expect(() => marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', buyer)).toThrowError(
      ForbiddenException
    );
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'cancelled', admin).status).toBe('cancelled');
  });

  it('treats re-sending the current status as an idempotent replay', () => {
    const { marketplace, events } = makeService();
    expect(marketplace.setOrderStatus('order-buyer-cassava', 'confirmed', buyer).status).toBe('confirmed');
    expect(events.listOutbox().filter((e) => e.name === 'marketplace.order.status_changed')).toHaveLength(0);

    marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer);
    marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer);
    expect(events.listOutbox().filter((e) => e.name === 'marketplace.order.status_changed')).toHaveLength(1);
  });

  it('keeps review gating on delivered/completed orders', () => {
    const { marketplace } = makeService();
    expect(() => marketplace.reviewOrder('order-buyer-cassava', 'user-buyer', 5)).toThrowError(
      BadRequestException
    );
  });
});
