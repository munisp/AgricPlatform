import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryCoopPoolRepository,
  type InMemoryCoopPoolRepository
} from '../../database/repositories/coop-pool.repository.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import {
  createInMemoryFeatureFlagRepository
} from '../../database/repositories/feature-flag.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  buildSplitPostings,
  computeSharesBps,
  COOP_POOL_FLAG,
  largestRemainderAllocation,
  memberPoolAccountCode,
  poolClearingAccountCode,
  poolSplitIdempotencyKey,
  splitPoolProceeds
} from './coop-pool.js';
import { CoopPoolService } from './coop-pool.service.js';
import { EscrowService } from './escrow.service.js';
import { MarketplaceService } from './marketplace.service.js';
import { StubEscrowPayoutDriver, type EscrowPayoutDriverPort } from './payout.driver.js';

const coopLead: User = {
  id: 'coop-1',
  phone: '+2348000000001',
  fullName: 'Coop Lead',
  preferredLanguage: 'en',
  roles: ['chapter_lead'],
  kycTier: 'tier_2',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z'
};
const admin: User = { ...coopLead, id: 'admin-1', roles: ['admin'] };
const buyer: Pick<User, 'id' | 'roles'> = { id: 'buyer-1', roles: ['buyer'] };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeWorld(options?: { payoutDriver?: EscrowPayoutDriverPort; flagEnabled?: boolean }) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const flags = new FeatureFlagsService(
    createInMemoryFeatureFlagRepository(
      options?.flagEnabled
        ? [
            {
              key: COOP_POOL_FLAG,
              enabled: true,
              roleAllowlist: [],
              percentage: 100,
              description: 'test flag'
            }
          ]
        : []
    )
  );
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const listings = createInMemoryListingRepository();
  const orders = createInMemoryOrderRepository(listings);
  const escrows = createInMemoryEscrowRepository();
  const marketplace = new MarketplaceService(events, listings, orders, createInMemoryReviewRepository());
  const escrow = new EscrowService(events, orders, escrows);
  const pools: InMemoryCoopPoolRepository = createInMemoryCoopPoolRepository();
  const service = new CoopPoolService(
    events,
    flags,
    ledger,
    marketplace,
    pools,
    orders,
    escrows,
    options?.payoutDriver
  );
  service.onModuleInit();
  return { events, flags, ledger, listings, orders, escrows, escrow, marketplace, pools, service };
}

/** Pool with 3 members (3kg/2kg/5kg), locked listing at ₦250/kg. */
async function lockedPool(world: ReturnType<typeof makeWorld>) {
  const pool = await world.service.createPool(coopLead, {
    cooperativeId: coopLead.id,
    title: 'Bulk maize pool',
    crop: 'maize',
    unitPriceNaira: 250,
    location: { state: 'Kaduna', lga: 'Zaria' },
    minPoolQtyKg: 5
  });
  await world.service.pledge(coopLead, pool.id, {
    memberUserId: 'member-a',
    qtyKg: 3,
    qualityGrade: 'A'
  });
  await world.service.pledge(coopLead, pool.id, {
    memberUserId: 'member-b',
    qtyKg: 2,
    qualityGrade: 'A'
  });
  await world.service.pledge(coopLead, pool.id, {
    memberUserId: 'member-c',
    qtyKg: 5,
    qualityGrade: 'B'
  });
  await world.service.lock(coopLead, pool.id);
  return pool;
}

describe('coop-pool split math', () => {
  it('allocates basis points summing to exactly 10000 (largest remainder)', () => {
    const shares = computeSharesBps([
      { id: 'c-3', qtyKg: 3 },
      { id: 'c-2', qtyKg: 2 },
      { id: 'c-5', qtyKg: 5 }
    ]);
    expect(shares.get('c-3')).toBe(3000);
    expect(shares.get('c-2')).toBe(2000);
    expect(shares.get('c-5')).toBe(5000);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('breaks equal-remainder ties deterministically by id', () => {
    const first = computeSharesBps([
      { id: 'a', qtyKg: 1 },
      { id: 'b', qtyKg: 1 },
      { id: 'c', qtyKg: 1 }
    ]);
    expect(first.get('a')).toBe(3334);
    expect(first.get('b')).toBe(3333);
    expect(first.get('c')).toBe(3333);
    // Reordered input must produce the same per-id allocation.
    const second = computeSharesBps([
      { id: 'c', qtyKg: 1 },
      { id: 'a', qtyKg: 1 },
      { id: 'b', qtyKg: 1 }
    ]);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it('splits odd kobo without losing or creating a kobo', () => {
    const contributions = [
      { id: 'a', memberUserId: 'm-a', ledgerAccountCode: 'acct:a', shareBps: 3334 },
      { id: 'b', memberUserId: 'm-b', ledgerAccountCode: 'acct:b', shareBps: 3333 },
      { id: 'c', memberUserId: 'm-c', ledgerAccountCode: 'acct:c', shareBps: 3333 }
    ];
    const allocations = splitPoolProceeds(10001, contributions);
    // 10001 kobo over shares 3334/3333/3333 bps: floors are 3334/3333/3333
    // (Σ 10000) and the single leftover kobo goes to the largest remainder
    // (member 'a', 3334.3334 exact) — nothing is lost or invented.
    expect(allocations.map((allocation) => allocation.amountKobo)).toEqual([3335, 3333, 3333]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.amountKobo, 0)).toBe(10001);
    const postings = buildSplitPostings('pool-1', 10001, allocations);
    const debits = postings
      .filter((posting) => posting.direction === 'debit')
      .reduce((sum, posting) => sum + posting.amountKobo, 0);
    const credits = postings
      .filter((posting) => posting.direction === 'credit')
      .reduce((sum, posting) => sum + posting.amountKobo, 0);
    expect(debits).toBe(10001);
    expect(credits).toBe(10001);
  });

  it('refuses a split that would leave a member with 0 kobo', () => {
    expect(() =>
      splitPoolProceeds(1, [
        { id: 'a', memberUserId: 'm-a', ledgerAccountCode: 'acct:a', shareBps: 5000 },
        { id: 'b', memberUserId: 'm-b', ledgerAccountCode: 'acct:b', shareBps: 5000 }
      ])
    ).toThrowError(BadRequestException);
  });

  it('rejects empty or non-positive allocation inputs', () => {
    expect(() => largestRemainderAllocation([], 100)).toThrowError(BadRequestException);
    expect(() =>
      largestRemainderAllocation([{ id: 'a', weight: 0 }], 100)
    ).toThrowError(BadRequestException);
    expect(() =>
      largestRemainderAllocation([{ id: 'a', weight: 1 }], 0)
    ).toThrowError(BadRequestException);
  });
});

describe('CoopPoolService pooling', () => {
  it('opens a pool, takes pledges, and locks with Σ shares = 10000 bps', async () => {
    const world = makeWorld();
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    expect(statement.pool.status).toBe('locked');
    expect(statement.pool.totalQtyKg).toBe(10);
    expect(statement.pool.listingId).toBeDefined();
    const shareSum = statement.contributions.reduce((sum, c) => sum + (c.shareBps ?? 0), 0);
    expect(shareSum).toBe(10000);
    expect(statement.contributions.every((c) => c.status === 'delivered')).toBe(true);
    // The lock opened a real marketplace listing sellable by buyers.
    const listing = await world.marketplace.getListing(statement.pool.listingId!);
    expect(listing.sellerId).toBe(coopLead.id);
    expect(listing.quantity).toBe(10);
    // Member sub-accounts and the clearing account exist before any money moves.
    await expect(
      world.ledger.getAccountByCode(memberPoolAccountCode('member-a'))
    ).resolves.toBeDefined();
    await expect(
      world.ledger.getAccountByCode(poolClearingAccountCode(pool.id))
    ).resolves.toBeDefined();
  });

  it('refuses to lock an under-subscribed pool', async () => {
    const world = makeWorld();
    const pool = await world.service.createPool(coopLead, {
      cooperativeId: coopLead.id,
      title: 'Small pool',
      unitPriceNaira: 100,
      location: { state: 'Kano', lga: 'Kano' },
      minPoolQtyKg: 10
    });
    await world.service.pledge(coopLead, pool.id, {
      memberUserId: 'member-a',
      qtyKg: 4,
      qualityGrade: 'A'
    });
    await expect(world.service.lock(coopLead, pool.id)).rejects.toThrowError(/under-subscribed/);
  });

  it('rejects duplicate member pledges and pledges after lock', async () => {
    const world = makeWorld();
    const pool = await lockedPool(world);
    await expect(
      world.service.pledge(coopLead, pool.id, { memberUserId: 'member-d', qtyKg: 1, qualityGrade: 'A' })
    ).rejects.toThrowError(ConflictException);
    const open = await world.service.createPool(coopLead, {
      cooperativeId: coopLead.id,
      title: 'Second pool',
      unitPriceNaira: 100,
      location: { state: 'Kano', lga: 'Kano' },
      minPoolQtyKg: 1
    });
    await world.service.pledge(coopLead, open.id, { memberUserId: 'member-a', qtyKg: 1, qualityGrade: 'A' });
    await expect(
      world.service.pledge(coopLead, open.id, { memberUserId: 'member-a', qtyKg: 2, qualityGrade: 'B' })
    ).rejects.toThrowError(ConflictException);
  });

  it('scopes pool management to the cooperative lead or admin', async () => {
    const world = makeWorld();
    const pool = await world.service.createPool(coopLead, {
      cooperativeId: coopLead.id,
      title: 'Scoped pool',
      unitPriceNaira: 100,
      location: { state: 'Kano', lga: 'Kano' },
      minPoolQtyKg: 1
    });
    const outsider = { ...coopLead, id: 'coop-2' };
    await expect(
      world.service.pledge(outsider, pool.id, { memberUserId: 'member-a', qtyKg: 1, qualityGrade: 'A' })
    ).rejects.toThrowError(/not found/);
    await expect(
      world.service.pledge(admin, pool.id, { memberUserId: 'member-a', qtyKg: 1, qualityGrade: 'A' })
    ).resolves.toBeDefined();
  });
});

describe('CoopPoolService settlement', () => {
  it('refuses to settle while the escrow is not RELEASED', async () => {
    const world = makeWorld();
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    const order = await world.marketplace.placeOrder(statement.pool.listingId!, buyer.id as string, 10);
    await world.escrow.holdForOrder(order.id, buyer.id as string);
    // Escrow HELD — not released: settle must conflict, pool stays locked.
    await expect(world.service.settle(pool.id, admin.id)).rejects.toThrowError(ConflictException);
    await expect(world.service.settle(pool.id, admin.id)).rejects.toThrowError(/RELEASED/);
    expect((await world.service.getStatement(pool.id)).pool.status).toBe('locked');
    expect(
      (await world.ledger.balance(memberPoolAccountCode('member-a'))).creditsKobo
    ).toBe(0);
  });

  it('fails closed 503 with the stub payout driver and credits nothing', async () => {
    const world = makeWorld({ payoutDriver: new StubEscrowPayoutDriver() });
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    const order = await world.marketplace.placeOrder(statement.pool.listingId!, buyer.id as string, 10);
    const record = await world.escrow.holdForOrder(order.id, buyer.id as string);
    // Force the escrow to released directly (declarative test path) — the
    // rail gate must STILL refuse the split with a stub driver.
    await world.escrows.update(record.id, { status: 'released' });
    await expect(world.service.settle(pool.id, admin.id)).rejects.toThrowError(
      ServiceUnavailableException
    );
    await expect(world.service.settle(pool.id, admin.id)).rejects.toThrowError(/PAYOUT_UNAVAILABLE/);
    const after = await world.service.getStatement(pool.id);
    expect(after.pool.status).toBe('locked');
    expect(after.split).toBeUndefined();
    expect(
      (await world.ledger.balance(memberPoolAccountCode('member-a'))).creditsKobo
    ).toBe(0);
  });

  it('splits a released escrow to member ledger accounts, exactly once', async () => {
    const world = makeWorld();
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    const order = await world.marketplace.placeOrder(statement.pool.listingId!, buyer.id as string, 10);
    const record = await world.escrow.holdForOrder(order.id, buyer.id as string);
    expect(record.amountKobo).toBe(250_000); // ₦250/kg × 10 kg
    await world.escrow.transition(record.id, 'released', buyer);

    const settled = await world.service.settle(pool.id, admin.id);
    expect(settled.pool.status).toBe('settled');
    expect(settled.split?.idempotencyKey).toBe(poolSplitIdempotencyKey(pool.id));
    expect(settled.split?.totalKobo).toBe(250_000);
    expect(settled.split?.memberCount).toBe(3);

    // Balanced split: member credits sum to the escrow release amount.
    const balances = await Promise.all(
      ['member-a', 'member-b', 'member-c'].map((member) =>
        world.ledger.balance(memberPoolAccountCode(member))
      )
    );
    expect(balances.map((balance) => balance.creditsKobo)).toEqual([75_000, 50_000, 125_000]);
    expect(balances.reduce((sum, balance) => sum + balance.creditsKobo, 0)).toBe(250_000);
    const clearing = await world.ledger.balance(poolClearingAccountCode(pool.id));
    expect(clearing.debitsKobo).toBe(250_000);
    expect(clearing.creditsKobo).toBe(0);

    // Contributions carry their payout and terminal status.
    for (const contribution of settled.contributions) {
      expect(contribution.status).toBe('paid');
      expect(contribution.amountKobo).toBeGreaterThan(0);
    }

    // The split journal is recorded under the deterministic idempotency key.
    const entry = await world.ledger.findEntryByIdempotencyKey(poolSplitIdempotencyKey(pool.id));
    expect(entry?.postings).toHaveLength(4);
    expect(settled.split?.ledgerEntryId).toBe(entry?.id);

    // marketplaces.pool.settled carries the per-member postings for audit.
    const settledEvents = (await world.events.listOutbox()).filter(
      (event) => event.name === 'marketplace.pool.settled'
    );
    expect(settledEvents).toHaveLength(1);
    const payload = settledEvents[0].payload as { postings: Array<{ amountKobo: number }> };
    expect(payload.postings.reduce((sum, p) => sum + p.amountKobo, 0)).toBe(250_000);

    // Replayed settle is a no-op: same statement, no double credit.
    const replay = await world.service.settle(pool.id, admin.id);
    expect(replay.split?.ledgerEntryId).toBe(settled.split?.ledgerEntryId);
    const balancesAfter = await Promise.all(
      ['member-a', 'member-b', 'member-c'].map((member) =>
        world.ledger.balance(memberPoolAccountCode(member))
      )
    );
    expect(balancesAfter.map((balance) => balance.creditsKobo)).toEqual([75_000, 50_000, 125_000]);
    expect(
      (await world.events.listOutbox()).filter((event) => event.name === 'marketplace.pool.settled')
    ).toHaveLength(1);
  });

  it('auto-settles through the escrow RELEASED outbox consumer when the flag is on', async () => {
    const world = makeWorld({ flagEnabled: true });
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    const order = await world.marketplace.placeOrder(statement.pool.listingId!, buyer.id as string, 10);
    const record = await world.escrow.holdForOrder(order.id, buyer.id as string);
    await world.escrow.transition(record.id, 'released', buyer); // fires the consumer
    await flush();
    await flush();
    const settled = await world.service.getStatement(pool.id);
    expect(settled.pool.status).toBe('settled');
    expect(settled.split?.escrowId).toBe(record.id);
    expect(
      (await world.ledger.balance(memberPoolAccountCode('member-c'))).creditsKobo
    ).toBe(125_000);
  });

  it('does not auto-settle while the feature flag is off (fail-closed)', async () => {
    const world = makeWorld({ flagEnabled: false });
    const pool = await lockedPool(world);
    const statement = await world.service.getStatement(pool.id);
    const order = await world.marketplace.placeOrder(statement.pool.listingId!, buyer.id as string, 10);
    const record = await world.escrow.holdForOrder(order.id, buyer.id as string);
    await world.escrow.transition(record.id, 'released', buyer);
    await flush();
    await flush();
    const after = await world.service.getStatement(pool.id);
    expect(after.pool.status).toBe('locked');
    expect(after.split).toBeUndefined();
    expect(
      (await world.ledger.balance(memberPoolAccountCode('member-a'))).creditsKobo
    ).toBe(0);
  });

  it('ignores escrow events for non-pool listings', async () => {
    const world = makeWorld({ flagEnabled: true });
    const listing = await world.marketplace.createListing({
      sellerId: 'seller-9',
      kind: 'produce',
      title: 'Solo listing',
      quantity: 5,
      unit: 'kg',
      priceNaira: 200,
      location: { state: 'Kano', lga: 'Kano' }
    });
    const order = await world.marketplace.placeOrder(listing.id, buyer.id as string, 5);
    const record = await world.escrow.holdForOrder(order.id, buyer.id as string);
    await world.escrow.transition(record.id, 'released', buyer);
    await flush();
    await flush();
    expect((await world.pools.find({})).length).toBe(0);
  });
});
