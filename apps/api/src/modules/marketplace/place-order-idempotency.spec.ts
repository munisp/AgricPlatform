import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { MarketplaceService } from './marketplace.service.js';

/**
 * WP-G11 (Stage 27, V2 idempotency-consistency audit): marketplace
 * placeOrder idempotency-record semantics. placeOrder gains an optional
 * client idempotency key; the canonical payload hash is stored with the
 * order so the same key with a DIFFERENT (listing, buyer, quantity)
 * payload fails closed with 409 IDEMPOTENCY_PAYLOAD_MISMATCH instead of
 * silently replaying, and concurrent twins converge on exactly ONE order
 * and ONE stock decrement.
 */

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  // Orders repo wired with the listings repo so placeOrder decrements stock
  // with the same compare-and-set guard as the pg conditional UPDATE.
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const marketplace = new MarketplaceService(
    events,
    listings,
    orders,
    createInMemoryReviewRepository()
  );
  return { marketplace, listings, orders, events };
}

type World = ReturnType<typeof makeService>;

async function makeListing(world: World, quantity = 10) {
  return world.marketplace.createListing({
    sellerId: 'seller-1',
    kind: 'produce',
    title: 'Maize lot',
    crop: 'maize',
    quantity,
    unit: 'kg',
    priceNaira: 250,
    location: { state: 'Kano', lga: 'Kano' }
  });
}


/** Orders for a listing (OrderCriteria.listingId is added by in-flight PR #67; filter locally). */
async function ordersFor(world: World, listingId: string) {
  return (await world.orders.find({})).filter((order) => order.listingId === listingId);
}

describe('WP-G11: marketplace placeOrder idempotency payload consistency', () => {
  it('same key + same payload replays the original order and never double-books stock', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    const first = await world.marketplace.placeOrder(listing.id, 'buyer-1', 4, 'order-key-1');
    const replay = await world.marketplace.placeOrder(listing.id, 'buyer-1', 4, 'order-key-1');
    expect(replay.id).toBe(first.id);
    expect(replay.payloadHash).toBe(first.payloadHash);
    expect(await ordersFor(world, listing.id)).toHaveLength(1);
    // Stock decremented exactly once.
    expect((await world.listings.getById(listing.id)).quantity).toBe(6);
    const placed = (await world.events.listOutbox()).filter(
      (event) => event.name === 'marketplace.order.placed'
    );
    expect(placed).toHaveLength(1);
  });

  it('same key + different quantity is a 409 IDEMPOTENCY_PAYLOAD_MISMATCH and books no stock', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    await world.marketplace.placeOrder(listing.id, 'buyer-1', 4, 'order-key-2');
    await expect(
      world.marketplace.placeOrder(listing.id, 'buyer-1', 7, 'order-key-2')
    ).rejects.toThrowError(ConflictException);
    await expect(
      world.marketplace.placeOrder(listing.id, 'buyer-1', 7, 'order-key-2')
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect(await ordersFor(world, listing.id)).toHaveLength(1);
    expect((await world.listings.getById(listing.id)).quantity).toBe(6);
  });

  it('same key + different buyer is a 409', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    await world.marketplace.placeOrder(listing.id, 'buyer-1', 4, 'order-key-3');
    await expect(
      world.marketplace.placeOrder(listing.id, 'buyer-2', 4, 'order-key-3')
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect(await ordersFor(world, listing.id)).toHaveLength(1);
  });

  it('same key + different listing is a 409', async () => {
    const world = makeService();
    const first = await makeListing(world, 10);
    const second = await makeListing(world, 10);
    await world.marketplace.placeOrder(first.id, 'buyer-1', 4, 'order-key-4');
    await expect(
      world.marketplace.placeOrder(second.id, 'buyer-1', 4, 'order-key-4')
    ).rejects.toThrowError(/IDEMPOTENCY_PAYLOAD_MISMATCH/);
    expect((await world.listings.getById(second.id)).quantity).toBe(10);
  });

  it('concurrent twins with the same key and payload create exactly ONE order and ONE decrement', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    const [a, b] = await Promise.allSettled([
      world.marketplace.placeOrder(listing.id, 'buyer-1', 3, 'order-twin'),
      world.marketplace.placeOrder(listing.id, 'buyer-1', 3, 'order-twin')
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    const first = (a as PromiseFulfilledResult<Awaited<ReturnType<MarketplaceService['placeOrder']>>>).value;
    const second = (b as PromiseFulfilledResult<Awaited<ReturnType<MarketplaceService['placeOrder']>>>).value;
    expect(second.id).toBe(first.id);
    expect(await ordersFor(world, listing.id)).toHaveLength(1);
    // The loser's stock decrement was compensated — exactly one decrement.
    expect((await world.listings.getById(listing.id)).quantity).toBe(7);
  });

  it('concurrent twins with the same key but DIFFERENT payloads: exactly one wins, the loser 409s', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    const [a, b] = await Promise.allSettled([
      world.marketplace.placeOrder(listing.id, 'buyer-1', 3, 'order-twin-mismatch'),
      world.marketplace.placeOrder(listing.id, 'buyer-1', 5, 'order-twin-mismatch')
    ]);
    const fulfilled = [a, b].filter((result) => result.status === 'fulfilled');
    const rejected = [a, b].filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(await ordersFor(world, listing.id)).toHaveLength(1);
  });

  it('orders without a key are unaffected (legacy keyless placement)', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    const first = await world.marketplace.placeOrder(listing.id, 'buyer-1', 2);
    const second = await world.marketplace.placeOrder(listing.id, 'buyer-1', 2);
    expect(second.id).not.toBe(first.id);
    expect((await world.listings.getById(listing.id)).quantity).toBe(6);
  });

  it('a keyless legacy order row replays under a later keyed lookup only when present — keyless rows never collide with keyed ones', async () => {
    const world = makeService();
    const listing = await makeListing(world, 10);
    await world.marketplace.placeOrder(listing.id, 'buyer-1', 2);
    const keyed = await world.marketplace.placeOrder(listing.id, 'buyer-1', 2, 'order-key-fresh');
    expect(keyed.idempotencyKey).toBe('order-key-fresh');
    expect(await ordersFor(world, listing.id)).toHaveLength(2);
  });
});
