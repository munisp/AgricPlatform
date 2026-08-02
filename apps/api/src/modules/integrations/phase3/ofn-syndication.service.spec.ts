import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../../database/repositories/outbox.repository.js';
import { createInMemoryInboundEventRepository } from '../../../database/repositories/phase3.repository.js';
import { createInMemoryReviewRepository } from '../../../database/repositories/review.repository.js';
import { MarketplaceService } from '../../marketplace/marketplace.service.js';
import type { OfnClient, OfnListingPush } from '../drivers/ofn.client.js';
import { OfnSyndicationService, settlementStatusFor } from './ofn-syndication.service.js';

class FakeOfnClient implements Pick<OfnClient, 'pushListing'> {
  readonly pushed: OfnListingPush[] = [];
  async pushListing(listing: OfnListingPush) {
    this.pushed.push(listing);
    return { productId: `ofn-${listing.sku}` };
  }
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const marketplace = new MarketplaceService(
    events,
    createInMemoryListingRepository(),
    createInMemoryOrderRepository(),
    createInMemoryReviewRepository()
  );
  const inbound = createInMemoryInboundEventRepository();
  const client = new FakeOfnClient();
  const service = new OfnSyndicationService(
    marketplace,
    inbound,
    events,
    client as unknown as OfnClient,
    env
  );
  return { events, marketplace, inbound, client, service };
}

describe('OfnSyndicationService', () => {
  it('pushes active listings with the platform id as SKU', async () => {
    const { service, client, marketplace } = setup();
    const active = (await marketplace.allListings()).filter((listing) => listing.isActive);
    const result = await service.syndicateActiveListings();
    expect(result.pushed).toBe(active.length);
    expect(client.pushed.map((push) => push.sku)).toEqual(active.map((listing) => listing.id));
  });

  it('fails closed while the driver is stub', async () => {
    const { marketplace, inbound, events } = setup();
    const stubbed = new OfnSyndicationService(marketplace, inbound, events, undefined, {
      OFN_DRIVER: 'stub'
    });
    expect(stubbed.enabled).toBe(false);
    await expect(stubbed.syndicateActiveListings()).rejects.toThrow(/OFN_DRIVER is stub/);
  });

  it('maps order events to marketplace domain events with settlement status', async () => {
    const { service, events, inbound } = setup();
    const published: Array<{ name: string; payload: unknown }> = [];
    const original = events.publish.bind(events);
    events.publish = async <T,>(name: string, payload: T, actorId?: string) => {
      published.push({ name, payload });
      return original(name, payload, actorId);
    };
    const result = await service.handleOrderEvent(
      { number: 'R100', sku: 'listing-9', quantity: 2, total: 84000, payment_state: 'paid' },
      'ofn-evt-1'
    );
    expect(result).toEqual({ received: true, settlementStatus: 'settled' });
    const orderEvent = published.find((entry) => entry.name === 'marketplace.ofn_order.received');
    expect(orderEvent?.payload).toMatchObject({
      ofnOrderId: 'R100',
      listingId: 'listing-9',
      settlementStatus: 'settled'
    });
    // Replay: same event id is a no-op.
    const replay = await service.handleOrderEvent({ number: 'R100' }, 'ofn-evt-1');
    expect(replay.received).toBe(false);
    expect(await inbound.all()).toHaveLength(1);
  });
});

describe('settlementStatusFor', () => {
  it('maps OFN payment states onto the settlement field', () => {
    expect(settlementStatusFor('paid')).toBe('settled');
    expect(settlementStatusFor('credit_owed')).toBe('invoiced');
    expect(settlementStatusFor('balance_due')).toBe('pending');
    expect(settlementStatusFor(undefined)).toBe('pending');
  });
});
