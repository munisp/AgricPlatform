import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentProviderPort, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { computeVatKobo } from '@agric-platform/shared';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryInvoiceRepository } from '../../database/repositories/invoice.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import {
  createInMemoryOrderExtensionRepository,
  createInMemorySellerRatingRepository
} from '../../database/repositories/commerce-depth.repository.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { MarketplaceService } from './marketplace.service.js';

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  // Orders repo wired with the listings repo so placeOrder decrements stock
  // with the same compare-and-set guard as the pg conditional UPDATE.
  const listings = createInMemoryListingRepository();
  return {
    marketplace: new MarketplaceService(
      events,
      listings,
      createInMemoryOrderRepository(listings),
      createInMemoryReviewRepository()
    ),
    listings,
    events
  };
}

// Seed order 'order-buyer-cassava' starts in 'confirmed' (buyer user-buyer, seller user-adamu).
describe('MarketplaceService order state machine', () => {
  it('walks the happy path with actor-scoped transitions', async () => {
    const { marketplace } = makeService();
    expect(
      (await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
        paymentReference: 'test:dep-happy'
      })).status
    ).toBe('deposit_paid');
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
    expect(
      (await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', admin, {
        paymentReference: 'test:dep-admin'
      })).status
    ).toBe('deposit_paid');
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

    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'test:dep-replay'
    });
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

describe('MarketplaceService oversell protection (funds-integrity wave)', () => {
  // Seed listing 'listing-maize-kano': quantity 2, seller user-farmer-2.

  it('decrements the listing quantity atomically with order placement', async () => {
    const { marketplace, listings } = makeService();
    await marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1);
    expect((await listings.getById('listing-maize-kano')).quantity).toBe(1);
    await marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1);
    expect((await listings.getById('listing-maize-kano')).quantity).toBe(0);
    // Stock exhausted: further orders are rejected.
    await expect(marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1)).rejects.toThrowError(
      /Quantity must be between 1 and 0/
    );
  });

  it('rejects concurrent orders that would oversell (exactly one winner)', async () => {
    const { marketplace, listings } = makeService();
    const [first, second] = await Promise.allSettled([
      marketplace.placeOrder('listing-maize-kano', 'user-buyer', 2),
      marketplace.placeOrder('listing-maize-kano', 'user-hassan', 2)
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(BadRequestException);
    // Stock left by the winner is consistent — never negative.
    expect((await listings.getById('listing-maize-kano')).quantity).toBe(0);
  });
});

// Wave P2a: order lifecycle hooks into escrow + invoicing (wired optionally).
// Hoisted to module scope so the Stage 22 verify-before-credit specs reuse it.
function makeWiredService(payments?: PaymentProviderPort) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository();
  const escrow = new EscrowService(events, orders, createInMemoryEscrowRepository(), payments);
  const invoices = new InvoiceService(
    events,
    createInMemoryInvoiceRepository(),
    orders,
    listings
  );
  const marketplace = new MarketplaceService(
    events,
    listings,
    orders,
    createInMemoryReviewRepository(),
    escrow,
    invoices,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    payments
  );
  return { marketplace, escrow, invoices, orders };
}

describe('MarketplaceService commerce hooks', () => {

  // Seller of seed listing 'listing-maize-kano'.
  const maizeSeller: Pick<User, 'id' | 'roles'> = { id: 'user-farmer-2', roles: ['farmer'] };

  it('issues the invoice on confirm and holds escrow on deposit', async () => {
    const { marketplace, escrow, invoices } = makeWiredService();
    // Seed order starts 'confirmed'; re-confirm from a fresh order instead.
    const order = await marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1);
    await marketplace.setOrderStatus(order.id, 'confirmed', maizeSeller);
    const invoice = await invoices.invoiceForOrder(order.id);
    expect(invoice?.status).toBe('issued');
    expect(invoice?.totalKobo).toBe(order.totalNaira * 100 + computeVatKobo(order.totalNaira * 100));

    await marketplace.setOrderStatus(order.id, 'deposit_paid', buyer, { paymentReference: 'test:dep-inv' });
    const held = await escrow.escrowForOrder(order.id);
    expect(held?.status).toBe('held');
    expect(held?.amountKobo).toBe(order.totalNaira * 100);
  });

  it('releases escrow and marks the invoice paid on completion', async () => {
    const { marketplace, escrow, invoices } = makeWiredService();
    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'test:dep-rel'
    });
    expect((await escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
    await marketplace.setOrderStatus('order-buyer-cassava', 'in_fulfilment', seller);
    await marketplace.setOrderStatus('order-buyer-cassava', 'delivered', seller);
    await marketplace.setOrderStatus('order-buyer-cassava', 'completed', buyer);
    expect((await escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('released');
    // Seed order was 'confirmed' before wiring, so no invoice exists → hook is a no-op.
    expect(await invoices.invoiceForOrder('order-buyer-cassava')).toBeUndefined();
  });

  it('cancels the invoice on cancellation before deposit', async () => {
    const { marketplace, escrow, invoices } = makeWiredService();
    const order = await marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1);
    await marketplace.setOrderStatus(order.id, 'confirmed', maizeSeller);
    await marketplace.setOrderStatus(order.id, 'cancelled', buyer);
    // No deposit was paid, so no escrow exists; the invoice is cancelled.
    expect(await escrow.escrowForOrder(order.id)).toBeUndefined();
    expect((await invoices.invoiceForOrder(order.id))?.status).toBe('cancelled');
  });

  it('keeps disputed escrows for admin resolution when a disputed order is cancelled', async () => {
    const { marketplace, escrow } = makeWiredService();
    const order = await marketplace.placeOrder('listing-maize-kano', 'user-buyer', 1);
    await marketplace.setOrderStatus(order.id, 'confirmed', maizeSeller);
    await marketplace.setOrderStatus(order.id, 'deposit_paid', buyer, { paymentReference: 'test:dep-dispute' });
    await marketplace.setOrderStatus(order.id, 'disputed', buyer);
    await marketplace.setOrderStatus(order.id, 'cancelled', admin);
    // Escrow stays disputed (money movement requires admin mediation).
    expect((await escrow.escrowForOrder(order.id))?.status).toBe('disputed');
    expect((await escrow.transition((await escrow.escrowForOrder(order.id))!.id, 'refunded', admin)).status).toBe(
      'refunded'
    );
  });
});

// Stage 22 (audit C2): verify-before-credit for the deposit_paid/escrow path.
describe('MarketplaceService verify-before-credit (audit C2)', () => {
  // Seed order 'order-buyer-cassava': totalNaira 370_000 → 37_000_000 kobo.
  const ORDER_KOBO = 37_000_000;

  function stubPayments(overrides: Partial<{ status: 'success' | 'pending' | 'failed'; amountKobo: number }> = {}) {
    const calls: string[] = [];
    const provider: PaymentProviderPort = {
      name: 'stub-paystack',
      verify: async (reference) => {
        calls.push(reference);
        return {
          reference,
          status: overrides.status ?? 'success',
          amountKobo: overrides.amountKobo ?? ORDER_KOBO,
          providerReference: `prov:${reference}`
        };
      },
      hold: async () => ({}),
      release: async () => {},
      refund: async () => {}
    };
    return { provider, calls };
  }

  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rejects deposit_paid without a paymentReference', async () => {
    const { marketplace } = makeWiredService();
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer)).rejects.toThrowError(
      BadRequestException
    );
    await expect(
      marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, { paymentReference: '  ' })
    ).rejects.toThrowError(/paymentReference/);
    // The rejected transition left the order untouched.
    expect((await marketplace.getOrder('order-buyer-cassava')).status).toBe('confirmed');
  });

  it('verifies the reference with the provider, then transitions and holds escrow', async () => {
    const { provider, calls } = stubPayments();
    const { marketplace, escrow } = makeWiredService(provider);
    const updated = await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'paystack:ref-ok'
    });
    expect(updated.status).toBe('deposit_paid');
    expect(calls).toEqual(['paystack:ref-ok']);
    const held = await escrow.escrowForOrder('order-buyer-cassava');
    expect(held?.status).toBe('held');
    expect(held?.amountKobo).toBe(ORDER_KOBO);
    expect(held?.depositReference).toBe('paystack:ref-ok');
    expect(held?.depositVerifiedAt).toBeDefined();
  });

  it('rejects a verified amount that does not match the order total', async () => {
    const { provider } = stubPayments({ amountKobo: ORDER_KOBO - 100 });
    const { marketplace, escrow } = makeWiredService(provider);
    await expect(
      marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
        paymentReference: 'paystack:ref-short'
      })
    ).rejects.toThrowError(/does not match/);
    expect((await marketplace.getOrder('order-buyer-cassava')).status).toBe('confirmed');
    expect(await escrow.escrowForOrder('order-buyer-cassava')).toBeUndefined();
  });

  it('rejects deposits the provider does not report as success', async () => {
    const { provider } = stubPayments({ status: 'pending' });
    const { marketplace } = makeWiredService(provider);
    await expect(
      marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
        paymentReference: 'paystack:ref-pending'
      })
    ).rejects.toThrowError(BadRequestException);
    expect((await marketplace.getOrder('order-buyer-cassava')).status).toBe('confirmed');
  });

  it('fails closed in production when no payment provider is configured', async () => {
    process.env.NODE_ENV = 'production';
    const { marketplace } = makeWiredService();
    await expect(
      marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
        paymentReference: 'declared-ref'
      })
    ).rejects.toThrowError(ServiceUnavailableException);
    expect((await marketplace.getOrder('order-buyer-cassava')).status).toBe('confirmed');
  });

  it('allows declarative deposits outside production without a provider, marked unverified', async () => {
    const { marketplace, escrow } = makeWiredService();
    const updated = await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'declared-ref'
    });
    expect(updated.status).toBe('deposit_paid');
    const held = await escrow.escrowForOrder('order-buyer-cassava');
    expect(held?.depositReference).toBe('declared-ref');
    expect(held?.depositVerifiedAt).toBeUndefined();
  });

  it('completes and auto-releases escrow for verified deposits', async () => {
    const { provider } = stubPayments();
    const { marketplace, escrow } = makeWiredService(provider);
    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'paystack:ref-ok'
    });
    await marketplace.setOrderStatus('order-buyer-cassava', 'in_fulfilment', seller);
    await marketplace.setOrderStatus('order-buyer-cassava', 'delivered', seller);
    await marketplace.setOrderStatus('order-buyer-cassava', 'completed', buyer);
    expect((await escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('released');
  });

  it('blocks completion auto-release for orders whose deposit was never verified', async () => {
    // Deposit reached declaratively (no provider wired at the time)…
    const { marketplace, escrow } = makeWiredService();
    await marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'declared-ref'
    });
    await marketplace.setOrderStatus('order-buyer-cassava', 'in_fulfilment', seller);
    await marketplace.setOrderStatus('order-buyer-cassava', 'delivered', seller);
    // …then the environment demands verification (production): completion is refused.
    process.env.NODE_ENV = 'production';
    await expect(marketplace.setOrderStatus('order-buyer-cassava', 'completed', buyer)).rejects.toThrowError(
      ConflictException
    );
    expect((await marketplace.getOrder('order-buyer-cassava')).status).toBe('delivered');
    expect((await escrow.escrowForOrder('order-buyer-cassava'))?.status).toBe('held');
  });
});

// Wave M: listing search responses expose the materialized seller rating.
describe('MarketplaceService listing search seller ratings (Wave M)', () => {
  it('enriches search results with the seller rating aggregate when wired', async () => {
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const listings = createInMemoryListingRepository();
    const ratings = createInMemorySellerRatingRepository();
    await ratings.applyReview('user-adamu', 5);
    await ratings.applyReview('user-adamu', 3);
    const marketplace = new MarketplaceService(
      events,
      listings,
      createInMemoryOrderRepository(listings),
      createInMemoryReviewRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      ratings
    );
    const page = await marketplace.listListings({});
    const cassava = page.data.find((listing) => listing.id === 'listing-cassava-kaduna');
    expect(cassava?.sellerRating?.average).toBe(4);
    const unrated = page.data.find((listing) => listing.id === 'listing-maize-kano');
    expect(unrated?.sellerRating).toBeUndefined();
  });

  it('omits ratings gracefully when the ratings repository is not wired', async () => {
    const { marketplace } = makeService();
    const page = await marketplace.listListings({});
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0].sellerRating).toBeUndefined();
  });
});

describe('MarketplaceService orders channel filter (G19)', () => {
  function makeChannelStack() {
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const listings = createInMemoryListingRepository();
    const orders = createInMemoryOrderRepository(listings);
    const extensions = createInMemoryOrderExtensionRepository();
    const marketplace = new MarketplaceService(
      events,
      listings,
      orders,
      createInMemoryReviewRepository(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      extensions
    );
    return { marketplace, orders, extensions };
  }

  it('filters orders by sales channel via the order_extensions side table', async () => {
    const { marketplace, orders, extensions } = makeChannelStack();
    const [webOrder] = await orders.all();
    const agentOrder = await orders.create({
      id: 'order-channel-test-2',
      listingId: webOrder.listingId,
      buyerId: 'user-channel-buyer',
      sellerId: webOrder.sellerId,
      quantity: 1,
      totalNaira: 1000,
      status: 'requested',
      escrowRequired: false,
      createdAt: new Date().toISOString()
    });
    const all = await orders.all();
    const now = new Date().toISOString();
    await extensions.create({
      id: webOrder.id,
      orderId: webOrder.id,
      channel: 'web',
      unitPriceKobo: 100,
      subtotalKobo: 100,
      discountKobo: 0,
      totalKobo: 100,
      createdAt: now,
      updatedAt: now
    });
    await extensions.create({
      id: agentOrder.id,
      orderId: agentOrder.id,
      channel: 'agent',
      unitPriceKobo: 100,
      subtotalKobo: 100,
      discountKobo: 0,
      totalKobo: 100,
      createdAt: now,
      updatedAt: now
    });
    const web = await marketplace.listOrders({ channel: 'web' });
    expect(web.map((order) => order.id)).toEqual([webOrder.id]);
    const agent = await marketplace.listOrders({ channel: 'agent' });
    expect(agent.map((order) => order.id)).toEqual([agentOrder.id]);
    // No channel filter → unchanged behaviour.
    const unfiltered = await marketplace.listOrders({});
    expect(unfiltered.length).toBe(all.length);
  });

  it('keeps party scoping when the channel filter is combined with buyerId', async () => {
    const { marketplace, orders, extensions } = makeChannelStack();
    const all = await orders.all();
    const now = new Date().toISOString();
    for (const order of all) {
      await extensions.create({
        id: order.id,
        orderId: order.id,
        channel: 'mobile',
        unitPriceKobo: 100,
        subtotalKobo: 100,
        discountKobo: 0,
        totalKobo: 100,
        createdAt: now,
        updatedAt: now
      });
    }
    const buyerOrders = await marketplace.listOrders({ buyerId: all[0].buyerId, channel: 'mobile' });
    expect(buyerOrders.every((order) => order.buyerId === all[0].buyerId)).toBe(true);
    const noMatch = await marketplace.listOrders({ channel: 'agent' });
    expect(noMatch).toEqual([]);
  });
});

describe('MarketplaceService certified listing link (G18)', () => {
  it('persists certifiedListingId on creation and returns it in responses', async () => {
    const { marketplace } = makeService();
    const created = await marketplace.createListing({
      sellerId: seller.id!,
      kind: 'produce',
      title: 'Certified White Fulani bull',
      quantity: 1,
      unit: 'head',
      priceNaira: 450_000,
      location: { state: 'Kaduna', lga: 'Kaduna North' },
      certifiedListingId: 'listing-certified-1'
    });
    expect(created.certifiedListingId).toBe('listing-certified-1');
    const fetched = await marketplace.getListing(created.id);
    expect(fetched.certifiedListingId).toBe('listing-certified-1');
  });

  it('leaves certifiedListingId absent for ordinary crop listings', async () => {
    const { marketplace } = makeService();
    const created = await marketplace.createListing({
      sellerId: seller.id!,
      kind: 'produce',
      title: 'Maize lot',
      crop: 'maize',
      quantity: 10,
      unit: 'tonnes',
      priceNaira: 250_000,
      location: { state: 'Kano', lga: 'Kano Municipal' }
    });
    expect(created.certifiedListingId).toBeUndefined();
  });
});
