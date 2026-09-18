import {
  BadRequestException,
  ConflictException,
  ForbiddenException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Order, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryInvoiceRepository } from '../../database/repositories/invoice.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { createInMemoryShipmentRepository } from '../../database/repositories/shipment.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  ESCROW_HOLDS_LIABILITY_ACCOUNT,
  ESCROW_PROVIDER_FLOAT_ACCOUNT
} from './escrow-ledger.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { LogisticsService } from './logistics.service.js';
import { MarketplaceService, partialReleaseKobo } from './marketplace.service.js';

/**
 * V-06 (partial dispute award) + V-36 (partial delivery / shipment failure
 * fast-track) — split-settlement specs.
 *
 * The defining invariant: a split settlement posts TWO balanced legs (seller
 * release part + buyer refund part) that sum EXACTLY to the held amount, and
 * replays are idempotent (no double-posted legs, no re-decided awards).
 */

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-aisha', roles: ['student'] };

function makeStack() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const escrow = new EscrowService(
    events,
    orders,
    createInMemoryEscrowRepository(),
    undefined, // no payment provider: declarative holds (non-production)
    undefined, // no payout driver: declarative money-out (non-production)
    undefined,
    undefined,
    undefined,
    ledger
  );
  const invoices = new InvoiceService(events, createInMemoryInvoiceRepository(), orders, listings);
  const marketplace = new MarketplaceService(
    events,
    listings,
    orders,
    createInMemoryReviewRepository(),
    escrow,
    invoices
  );
  const logistics = new LogisticsService(
    events,
    createInMemoryShipmentRepository(),
    orders,
    escrow,
    marketplace
  );
  return { events, ledger, listings, orders, escrow, marketplace, logistics };
}

/** Seed order: 'order-buyer-cassava', quantity 2, ₦370,000 (37,000,000 kobo). */
async function disputedEscrow(stack: ReturnType<typeof makeStack>) {
  await stack.marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
    paymentReference: 'test:dep-dispute'
  });
  await stack.marketplace.setOrderStatus('order-buyer-cassava', 'disputed', buyer);
  const record = await stack.escrow.escrowForOrder('order-buyer-cassava');
  if (!record) throw new Error('expected an escrow record');
  return record;
}

describe('V-06 escrow split settlement (partial dispute award)', () => {
  it('resolves a dispute 60/40: two balanced legs summing exactly to the held amount', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    expect(record.status).toBe('disputed');
    expect(record.amountKobo).toBe(37_000_000);

    const releaseKobo = 22_200_000; // 60% to the seller
    const refundKobo = 14_800_000; // 40% back to the buyer
    const settled = await stack.escrow.resolveDisputeSplit(
      record.id,
      { releaseKobo, refundKobo },
      admin
    );
    expect(settled.status).toBe('settled');
    expect(settled.releasedKobo).toBe(releaseKobo);
    expect(settled.refundedKobo).toBe(refundKobo);
    expect(settled.releasedKobo! + settled.refundedKobo!).toBe(record.amountKobo);
    expect(settled.resolvedAt).toBeDefined();

    // Balanced: the hold liability and the provider float both net to zero
    // (hold 37,000,000 CR / DR, split legs 22,200,000 + 14,800,000 DR / CR).
    const holds = await stack.ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT);
    const float = await stack.ledger.balance(ESCROW_PROVIDER_FLOAT_ACCOUNT);
    expect(holds.balanceKobo).toBe(0);
    expect(float.balanceKobo).toBe(0);
  });

  it('is idempotent: replaying the same award re-ensures legs without double-posting', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    const award = { releaseKobo: 22_200_000, refundKobo: 14_800_000 };
    const first = await stack.escrow.resolveDisputeSplit(record.id, award, admin);
    const replay = await stack.escrow.resolveDisputeSplit(record.id, award, admin);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('settled');
    // No double-posted legs: balances are still exactly zero.
    expect((await stack.ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT)).balanceKobo).toBe(0);
    expect((await stack.ledger.balance(ESCROW_PROVIDER_FLOAT_ACCOUNT)).balanceKobo).toBe(0);
  });

  it('refuses to re-decide a settled escrow with different amounts', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    await stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 22_200_000, refundKobo: 14_800_000 }, admin);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 18_500_000, refundKobo: 18_500_000 }, admin)
    ).rejects.toThrowError(ConflictException);
  });

  it('rejects awards that do not sum exactly to the held amount', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 20_000_000, refundKobo: 15_000_000 }, admin)
    ).rejects.toThrowError(/sum EXACTLY/);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 0, refundKobo: 0 }, admin)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: -1, refundKobo: 37_000_001 }, admin)
    ).rejects.toThrowError(BadRequestException);
  });

  it('is admin-mediated only and requires a disputed escrow', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 22_200_000, refundKobo: 14_800_000 }, outsider)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      stack.escrow.resolveDisputeSplit(record.id, { releaseKobo: 22_200_000, refundKobo: 14_800_000 }, buyer)
    ).rejects.toThrowError(ForbiddenException);
  });

  it('never exposes the settled status through the generic transition machine', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    await expect(stack.escrow.transition(record.id, 'settled', admin)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('degenerate awards ride the existing all-or-nothing rails', async () => {
    const stack = makeStack();
    const record = await disputedEscrow(stack);
    const released = await stack.escrow.resolveDisputeSplit(
      record.id,
      { releaseKobo: 37_000_000, refundKobo: 0 },
      admin
    );
    expect(released.status).toBe('released');
    expect((await stack.ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT)).balanceKobo).toBe(0);
  });

  it('MarketplaceService.resolveDispute settles the escrow and completes the order', async () => {
    const stack = makeStack();
    await disputedEscrow(stack);
    const order = await stack.marketplace.resolveDispute(
      'order-buyer-cassava',
      { releaseKobo: 22_200_000 },
      admin
    );
    expect(order.status).toBe('completed');
    const record = await stack.escrow.escrowForOrder('order-buyer-cassava');
    expect(record?.status).toBe('settled');
    expect(record?.refundedKobo).toBe(14_800_000);
    // Idempotent replay of the resolution.
    const replayed = await stack.marketplace.resolveDispute(
      'order-buyer-cassava',
      { releaseKobo: 22_200_000 },
      admin
    );
    expect(replayed.status).toBe('completed');
  });

  it('a full buyer award cancels the order and refunds in full', async () => {
    const stack = makeStack();
    await disputedEscrow(stack);
    const order = await stack.marketplace.resolveDispute(
      'order-buyer-cassava',
      { releaseKobo: 0 },
      admin
    );
    expect(order.status).toBe('cancelled');
    const record = await stack.escrow.escrowForOrder('order-buyer-cassava');
    expect(record?.status).toBe('refunded');
  });
});

describe('V-36 partial fulfilment + shipment failure fast-track', () => {
  /** Creates a 10-unit order at ₦100,000 (10,000,000 kobo) in 'in_fulfilment' with a held escrow. */
  async function partialOrder(stack: ReturnType<typeof makeStack>): Promise<Order> {
    const order: Order = {
      id: 'order-partial-70',
      listingId: 'listing-cassava-kaduna',
      buyerId: buyer.id,
      sellerId: seller.id,
      quantity: 10,
      totalNaira: 100_000,
      status: 'in_fulfilment',
      escrowRequired: true,
      createdAt: new Date().toISOString()
    };
    await stack.orders.create(order);
    await stack.escrow.holdForOrder(order.id, buyer.id);
    return order;
  }

  it('70% delivery settles 70% of the escrow to the seller and refunds 30%', async () => {
    const stack = makeStack();
    const order = await partialOrder(stack);
    expect(partialReleaseKobo(10_000_000, 7, 10)).toBe(7_000_000);

    const delivered = await stack.marketplace.recordPartialDelivery(order.id, 7, seller);
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredQuantity).toBe(7);

    const completed = await stack.marketplace.setOrderStatus(order.id, 'completed', buyer);
    expect(completed.status).toBe('completed');
    const record = await stack.escrow.escrowForOrder(order.id);
    expect(record?.status).toBe('settled');
    expect(record?.releasedKobo).toBe(7_000_000);
    expect(record?.refundedKobo).toBe(3_000_000);
    expect(record!.releasedKobo! + record!.refundedKobo!).toBe(record!.amountKobo);
    expect((await stack.ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT)).balanceKobo).toBe(0);
  });

  it('recordPartialDelivery is seller-scoped, replayable and conflict-safe', async () => {
    const stack = makeStack();
    const order = await partialOrder(stack);
    await expect(stack.marketplace.recordPartialDelivery(order.id, 7, buyer)).rejects.toThrowError(
      ForbiddenException
    );
    await expect(stack.marketplace.recordPartialDelivery(order.id, 10, seller)).rejects.toThrowError(
      BadRequestException
    );
    await stack.marketplace.recordPartialDelivery(order.id, 7, seller);
    // Same quantity: idempotent replay. Different quantity: 409.
    const replay = await stack.marketplace.recordPartialDelivery(order.id, 7, seller);
    expect(replay.deliveredQuantity).toBe(7);
    await expect(stack.marketplace.recordPartialDelivery(order.id, 5, seller)).rejects.toThrowError(
      ConflictException
    );
  });

  it('a terminally failed shipment refunds the escrow immediately instead of waiting for expiry', async () => {
    const stack = makeStack();
    await stack.marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'test:dep-shipfail'
    });
    const shipment = await stack.logistics.schedulePickup(
      'order-buyer-cassava',
      { carrier: 'test-carrier' },
      seller
    );
    await stack.logistics.transition(shipment.id, 'in_transit', seller);
    const failed = await stack.logistics.failAndRefund(shipment.id, seller, 'truck broke down, goods lost');
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('goods lost');
    const order = await stack.marketplace.getOrder('order-buyer-cassava');
    expect(order.status).toBe('cancelled');
    const record = await stack.escrow.escrowForOrder('order-buyer-cassava');
    expect(record?.status).toBe('refunded');
    expect((await stack.ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT)).balanceKobo).toBe(0);
  });

  it('a recoverable failure still reschedules without touching the escrow', async () => {
    const stack = makeStack();
    await stack.marketplace.setOrderStatus('order-buyer-cassava', 'deposit_paid', buyer, {
      paymentReference: 'test:dep-resched'
    });
    const shipment = await stack.logistics.schedulePickup('order-buyer-cassava', {}, seller);
    await stack.logistics.transition(shipment.id, 'in_transit', seller);
    await stack.logistics.transition(shipment.id, 'failed', seller, 'address unreachable');
    const record = await stack.escrow.escrowForOrder('order-buyer-cassava');
    expect(record?.status).toBe('held'); // no refund — a reschedule is pending
    const rescheduled = await stack.logistics.schedulePickup(
      'order-buyer-cassava',
      { carrier: 'other-carrier' },
      seller
    );
    expect(rescheduled.status).toBe('pickup_scheduled');
  });
});
