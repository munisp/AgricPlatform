import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryListingVariantRepository,
  createInMemoryOrderExtensionRepository,
  createInMemoryReturnRequestRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { EscrowService } from '../marketplace/escrow.service.js';
import { ReturnsService } from './returns.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

// Seed order 'order-buyer-cassava': buyer user-buyer, seller user-adamu,
// starts 'confirmed' — driven to delivered/completed per test.
function makeStack() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const extensions = createInMemoryOrderExtensionRepository();
  const variants = createInMemoryListingVariantRepository();
  const returns = createInMemoryReturnRequestRepository();
  const escrow = new EscrowService(events, orders, createInMemoryEscrowRepository());
  const service = new ReturnsService(events, returns, orders, extensions, listings, variants, escrow);
  return { events, orders, listings, returns, escrow, service };
}

async function fulfill(stack: ReturnType<typeof makeStack>) {
  await stack.orders.updateExpected('order-buyer-cassava', { status: 'deposit_paid' }, { status: 'confirmed' });
  await stack.orders.updateExpected('order-buyer-cassava', { status: 'in_fulfilment' }, { status: 'deposit_paid' });
  await stack.orders.updateExpected('order-buyer-cassava', { status: 'delivered' }, { status: 'in_fulfilment' });
}

describe('ReturnsService request', () => {
  it('creates a return request on a fulfilled order', async () => {
    const stack = makeStack();
    await fulfill(stack);
    const request = await stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'Bags torn', false, buyer);
    expect(request.status).toBe('requested');
    expect(request.id).toMatch(/^return-/);
  });

  it('rejects returns on unfulfilled orders', async () => {
    const stack = makeStack();
    await expect(
      stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'Changed mind', false, buyer)
    ).rejects.toThrowError(/fulfilled/);
  });

  it('enforces buyer-only requests and requires a reason', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await expect(
      stack.service.requestReturn('order-buyer-cassava', 'user-hassan', 'x', false, admin)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'x', false, outsider)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      stack.service.requestReturn('order-buyer-cassava', 'user-buyer', '  ', false, buyer)
    ).rejects.toThrowError(BadRequestException);
  });

  it('rejects a second open return for the same order', async () => {
    const stack = makeStack();
    await fulfill(stack);
    await stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'Bags torn', false, buyer);
    await expect(
      stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'Also late', false, buyer)
    ).rejects.toThrowError(ConflictException);
  });
});

describe('ReturnsService state machine', () => {
  async function openReturn(restock = false) {
    const stack = makeStack();
    await fulfill(stack);
    const request = await stack.service.requestReturn('order-buyer-cassava', 'user-buyer', 'Bags torn', restock, buyer);
    return { stack, request };
  }

  it('walks requested → approved → received → refunded with actor scoping', async () => {
    const { stack, request } = await openReturn();
    await expect(stack.service.transition(request.id, 'approved', buyer)).rejects.toThrowError(ForbiddenException);
    await expect(stack.service.transition(request.id, 'refunded', seller)).rejects.toThrowError(BadRequestException);
    expect((await stack.service.transition(request.id, 'approved', seller)).status).toBe('approved');
    expect((await stack.service.transition(request.id, 'received', seller)).status).toBe('received');
    expect((await stack.service.transition(request.id, 'refunded', seller)).status).toBe('refunded');
    // Terminal: idempotent replay only.
    expect((await stack.service.transition(request.id, 'refunded', seller)).status).toBe('refunded');
    await expect(stack.service.transition(request.id, 'rejected', admin)).rejects.toThrowError(BadRequestException);
  });

  it('lets the buyer withdraw an open request (rejected)', async () => {
    const { stack, request } = await openReturn();
    expect((await stack.service.transition(request.id, 'rejected', buyer)).status).toBe('rejected');
  });

  it('invokes the guarded escrow refund path on refunded', async () => {
    const { stack, request } = await openReturn();
    // Hold escrow first (order was deposit_paid before fulfilment).
    await stack.escrow.holdForOrder('order-buyer-cassava', 'user-buyer');
    await stack.service.transition(request.id, 'approved', seller);
    await stack.service.transition(request.id, 'received', seller);
    await stack.service.transition(request.id, 'refunded', admin);
    expect((await stack.escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('refunded');
  });

  it('refunded is a no-op on the escrow side when nothing is held', async () => {
    const { stack, request } = await openReturn();
    await stack.service.transition(request.id, 'approved', seller);
    await stack.service.transition(request.id, 'received', seller);
    await stack.service.transition(request.id, 'refunded', seller);
    expect(await stack.escrow.escrowForOrder('order-buyer-cassava')).toBeUndefined();
  });

  it('restocks the listing on received when requested', async () => {
    const { stack, request } = await openReturn(true);
    const before = (await stack.orders.getById('order-buyer-cassava')).quantity;
    expect(before).toBe(2);
    const listingBefore = (await stack.listings.getById('listing-cassava-kaduna')).quantity;
    await stack.service.transition(request.id, 'approved', seller);
    await stack.service.transition(request.id, 'received', seller);
    expect((await stack.listings.getById('listing-cassava-kaduna')).quantity).toBe(listingBefore + 2);
  });

  it('does not restock when restock was not requested', async () => {
    const { stack, request } = await openReturn(false);
    const listingBefore = (await stack.listings.getById('listing-cassava-kaduna')).quantity;
    await stack.service.transition(request.id, 'approved', seller);
    await stack.service.transition(request.id, 'received', seller);
    expect((await stack.listings.getById('listing-cassava-kaduna')).quantity).toBe(listingBefore);
  });

  it('publishes status-changed events with from/to', async () => {
    const { stack, request } = await openReturn();
    await stack.service.transition(request.id, 'approved', seller);
    const events = (await stack.events.listOutbox()).filter((e) => e.name === 'marketplace.return.status_changed');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ from: 'requested', to: 'approved' });
  });
});
