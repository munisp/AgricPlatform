import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Profile, User } from '@agric-platform/shared';
import { computeVatKobo } from '@agric-platform/shared';
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
import { createInMemoryCommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import {
  createInMemoryOfftakeContractRepository
} from '../../database/repositories/offtake.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { MarketplaceService } from './marketplace.service.js';
import type { CommodityLot } from '../traceability/traceability.types.js';
import {
  buyerEscrowAccountCode,
  contractEscrowLiabilityAccountCode,
  coopReceivableAccountCode
} from './offtake.js';
import {
  OFFTAKE_EVENTS,
  OfftakeService,
  type CreateOfftakeContractInput,
  type RecordDeliveryInput
} from './offtake.service.js';

/**
 * Harvest Forward Contracts (Stage 27, Innovation 18) — service tests over
 * the in-memory repositories, including the full delivery saga
 * (contract -> accept -> delivery -> invoice -> escrow hold -> escrow
 * release -> settlement posting) and the countersign CAS race.
 */

const coop = { id: 'user-coop', roles: ['chapter_lead'] } as User;
const buyer = { id: 'user-buyer', roles: ['buyer'] } as User;
const lender = { id: 'user-lender', roles: ['lender'] } as User;
const admin = { id: 'user-admin', roles: ['admin'] } as User;
const outsider = { id: 'user-outsider', roles: ['farmer'] } as User;

const COOP_PROFILE: Profile = {
  userId: coop.id,
  location: { state: 'Kano', lga: 'Kano Municipal' },
  farmingInterests: [],
  valueChains: [],
  badges: [],
  completionScore: 50
} as Profile;

function makeLot(id: string, ownerUserId = coop.id): CommodityLot {
  return {
    id,
    ownerUserId,
    crop: 'maize',
    harvestWindowStart: '2027-03-01',
    harvestWindowEnd: '2027-04-30',
    quantity: 5_000,
    unit: 'kg',
    status: 'active',
    parentLotIds: [],
    createdAt: '2027-03-10T00:00:00.000Z',
    updatedAt: '2027-03-10T00:00:00.000Z'
  };
}

function contractInput(overrides: Partial<CreateOfftakeContractInput> = {}): CreateOfftakeContractInput {
  return {
    cooperativeId: coop.id,
    buyerOrgId: buyer.id,
    commodity: 'maize',
    qtyKg: 5_000,
    priceBand: { floorKoboPerKg: 40_000, capKoboPerKg: 60_000 },
    windowStart: '2027-01-01',
    windowEnd: '2027-12-31',
    milestones: [
      { seq: 1, dueDate: '2027-06-30', qtyKg: 2_000 },
      { seq: 2, dueDate: '2027-12-31', qtyKg: 3_000 }
    ],
    ...overrides
  };
}

function deliveryInput(overrides: Partial<RecordDeliveryInput> = {}): RecordDeliveryInput {
  return {
    milestoneSeq: 1,
    lotId: 'lot-1',
    qtyKg: 1_000,
    priceKoboPerKg: 50_000,
    idempotencyKey: 'del-key-1',
    depositReference: 'dep-ref-1',
    ...overrides
  };
}

function makeService(options?: { profiles?: Partial<ProfilesService> }) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const contracts = createInMemoryOfftakeContractRepository();
  const orders = createInMemoryOrderRepository();
  const escrows = createInMemoryEscrowRepository();
  const listings = createInMemoryListingRepository();
  const invoiceRepo = createInMemoryInvoiceRepository();
  const lots = createInMemoryCommodityLotRepository();
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const escrow = new EscrowService(events, orders, escrows);
  const invoices = new InvoiceService(events, invoiceRepo, orders, listings);
  const marketplace = new MarketplaceService(
    events,
    listings,
    orders,
    createInMemoryReviewRepository(),
    escrow,
    invoices
  );
  const profiles = {
    get: async (userId: string) => {
      if (userId !== coop.id) {
        throw new NotFoundException(`Profile for '${userId}' not found`);
      }
      return COOP_PROFILE;
    },
    ...options?.profiles
  } as unknown as ProfilesService;
  const service = new OfftakeService(
    events,
    ledger,
    marketplace,
    escrow,
    invoices,
    profiles,
    contracts,
    orders,
    invoiceRepo,
    listings,
    lots
  );
  return { service, events, contracts, orders, escrows, invoiceRepo, listings, lots, ledger, escrow };
}

async function activeContract(
  ctx: ReturnType<typeof makeService>,
  input: CreateOfftakeContractInput = contractInput()
) {
  const { contract, milestones } = await ctx.service.createContract(coop, input);
  const accepted = await ctx.service.accept(buyer, contract.id);
  return { contract: accepted, milestones };
}

/** Flush the microtask queue so fire-and-forget event listeners settle. */
async function flushListeners(turns = 30): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

describe('OfftakeService contract creation', () => {
  it('drafts a contract with its milestone plan and emits marketplace.offtake.created', async () => {
    const ctx = makeService();
    const { contract, milestones } = await ctx.service.createContract(coop, contractInput());
    expect(contract.status).toBe('draft');
    expect(milestones.map((milestone) => milestone.seq)).toEqual([1, 2]);
    expect(milestones.every((milestone) => milestone.status === 'pending')).toBe(true);
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.created);
  });

  it('replays creation on the same idempotency key', async () => {
    const ctx = makeService();
    const first = await ctx.service.createContract(coop, contractInput({ idempotencyKey: 'create-1' }));
    const second = await ctx.service.createContract(coop, contractInput({ idempotencyKey: 'create-1' }));
    expect(second.contract.id).toBe(first.contract.id);
    expect(second.milestones).toHaveLength(2);
  });

  it('rejects plans that do not cover the contracted volume', async () => {
    const ctx = makeService();
    await expect(
      ctx.service.createContract(
        coop,
        contractInput({ milestones: [{ seq: 1, dueDate: '2027-06-30', qtyKg: 4_999 }] })
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects inverted windows and invalid bands', async () => {
    const ctx = makeService();
    await expect(
      ctx.service.createContract(coop, contractInput({ windowStart: '2027-12-31', windowEnd: '2027-01-01' }))
    ).rejects.toThrow(BadRequestException);
    await expect(
      ctx.service.createContract(
        coop,
        contractInput({ priceBand: { floorKoboPerKg: 60_000, capKoboPerKg: 40_000 } })
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects same-party contracts and non-party drafters', async () => {
    const ctx = makeService();
    await expect(
      ctx.service.createContract(coop, contractInput({ buyerOrgId: coop.id }))
    ).rejects.toThrow(BadRequestException);
    await expect(ctx.service.createContract(outsider, contractInput())).rejects.toThrow(
      ForbiddenException
    );
  });

  it('fails closed when the cooperative has no profile (never invents a location)', async () => {
    const ctx = makeService();
    await expect(
      ctx.service.createContract(admin, contractInput({ cooperativeId: 'user-coop-anon' }))
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

describe('OfftakeService countersign CAS', () => {
  it('accepts exactly once: a concurrent accept loses with 409', async () => {
    const ctx = makeService();
    const { contract } = await ctx.service.createContract(coop, contractInput());
    const [first, second] = await Promise.allSettled([
      ctx.service.accept(buyer, contract.id),
      ctx.service.accept(buyer, contract.id)
    ]);
    const outcomes = [first, second].map((result) => result.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const loser = [first, second].find((result) => result.status === 'rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((await ctx.contracts.getById(contract.id)).status).toBe('active');
  });

  it('rejects a repeated accept (exactly one accept, ever)', async () => {
    const ctx = makeService();
    const { contract } = await ctx.service.createContract(coop, contractInput());
    await ctx.service.accept(buyer, contract.id);
    await expect(ctx.service.accept(buyer, contract.id)).rejects.toThrow(ConflictException);
  });

  it('only the buyer countersigns; non-parties get 404', async () => {
    const ctx = makeService();
    const { contract } = await ctx.service.createContract(coop, contractInput());
    await expect(ctx.service.accept(coop, contract.id)).rejects.toThrow(ForbiddenException);
    await expect(ctx.service.accept(outsider, contract.id)).rejects.toThrow(NotFoundException);
  });
});

describe('OfftakeService delivery saga', () => {
  it('records a delivery end-to-end: lot -> milestone -> invoice -> escrow hold -> ledger', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    const result = await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    expect(result.replay).toBe(false);
    expect(result.delivery.amountKobo).toBe(50_000_000);
    expect(result.milestone.status).toBe('partial');
    expect(result.milestone.deliveredQtyKg).toBe(1_000);
    expect(result.milestone.linkedLotId).toBe('lot-1');
    // Auto-invoice at the delivery price (subtotal = kobo amount, VAT on top).
    expect(result.invoice?.subtotalKobo).toBe(50_000_000);
    expect(result.invoice?.vatKobo).toBe(computeVatKobo(50_000_000));
    expect(result.invoice?.sellerId).toBe(coop.id);
    expect(result.invoice?.buyerId).toBe(buyer.id);
    // Escrow held for exactly the delivery amount on the existing rails.
    const escrow = await ctx.escrow.escrowForOrder(result.order.id);
    expect(escrow?.status).toBe('held');
    expect(escrow?.amountKobo).toBe(50_000_000);
    expect(result.order.status).toBe('deposit_paid');
    // Escrow-hold journal posted through the ledger (balanced, kobo).
    const buyerEscrow = await ctx.ledger.balance(buyerEscrowAccountCode(buyer.id));
    expect(buyerEscrow.debitsKobo).toBe(50_000_000);
    const liability = await ctx.ledger.balance(contractEscrowLiabilityAccountCode(contract.id));
    expect(liability.creditsKobo).toBe(50_000_000);
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.deliveryRecorded);
  });

  it('partial deliveries accumulate; the milestone is met at the contracted quantity; the contract fulfils', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const second = await ctx.service.recordDelivery(
      coop,
      contract.id,
      deliveryInput({ qtyKg: 1_000, idempotencyKey: 'del-key-2', depositReference: 'dep-ref-2' })
    );
    expect(second.milestone.status).toBe('met');
    expect(second.milestone.deliveredQtyKg).toBe(2_000);
    const third = await ctx.service.recordDelivery(
      coop,
      contract.id,
      deliveryInput({ milestoneSeq: 2, qtyKg: 3_000, idempotencyKey: 'del-key-3', depositReference: 'dep-ref-3' })
    );
    expect(third.contract.status).toBe('fulfilled');
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.milestoneMet);
    expect(names).toContain(OFFTAKE_EVENTS.fulfilled);
  });

  it('replays a delivery on the same idempotency key without double-posting', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    const first = await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const replay = await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    expect(replay.replay).toBe(true);
    expect(replay.delivery.id).toBe(first.delivery.id);
    const buyerEscrow = await ctx.ledger.balance(buyerEscrowAccountCode(buyer.id));
    expect(buyerEscrow.debitsKobo).toBe(50_000_000); // posted exactly once
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.deliveredQtyKg).toBe(1_000);
  });

  it('refuses a price outside the band with a renegotiation event — never silently re-priced', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ priceKoboPerKg: 70_000 }))
    ).rejects.toThrow(UnprocessableEntityException);
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.renegotiationRequired);
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.deliveredQtyKg).toBe(0); // no milestone progress
  });

  it('refuses kobo-precision prices the naira order rail cannot settle exactly', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ priceKoboPerKg: 45_050 }))
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses deliveries without traceability evidence (no lot, no progress)', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ lotId: 'lot-missing' }))
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("refuses evidence that is not the selling cooperative's own lot", async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1', 'user-other'));
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput())
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses over-delivery beyond the contracted milestone quantity', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ qtyKg: 2_001 }))
    ).rejects.toThrow(ConflictException);
  });

  it('requires the buyer deposit reference (verify-before-credit) and moves nothing money-side without it', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ depositReference: undefined }))
    ).rejects.toThrow(BadRequestException);
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.deliveredQtyKg).toBe(0);
    expect(await ctx.contracts.listDeliveries(contract.id)).toHaveLength(0);
  });

  it('scopes the mutation: the buyer cannot deliver, outsiders see nothing', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await expect(ctx.service.recordDelivery(buyer, contract.id, deliveryInput())).rejects.toThrow(
      ForbiddenException
    );
    await expect(ctx.service.recordDelivery(outsider, contract.id, deliveryInput())).rejects.toThrow(
      NotFoundException
    );
  });

  it('V-50: two concurrent deliveries for the same milestone — one wins the reservation, the loser orphans nothing', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    // Milestone 1 has exactly 2_000 kg; two full-quantity deliveries race.
    const [first, second] = await Promise.allSettled([
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ qtyKg: 2_000 })),
      ctx.service.recordDelivery(
        coop,
        contract.id,
        deliveryInput({ qtyKg: 2_000, idempotencyKey: 'del-key-twin', depositReference: 'dep-ref-twin' })
      )
    ]);
    const outcomes = [first, second].map((result) => result.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const loser = [first, second].find((result) => result.status === 'rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    // The loser 409'd at the reservation CAS, BEFORE the payment rails:
    // exactly one offtake order, one held escrow and one delivery exist.
    const offtakeOrders = (await ctx.orders.all()).filter((order) =>
      order.id.startsWith('order-offdel-')
    );
    expect(offtakeOrders).toHaveLength(1);
    expect((await ctx.escrows.all()).filter((record) => record.status === 'held')).toHaveLength(1);
    expect(await ctx.contracts.listDeliveries(contract.id)).toHaveLength(1);
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.deliveredQtyKg).toBe(2_000);
    expect(milestone?.status).toBe('met');
  });

  it('V-50 fault injection: permanent commit failure compensates — order cancelled, escrow refunded, no orphan', async () => {
    const ctx = makeService();
    ctx.service.onModuleInit(); // settlement listener must not settle a refunded escrow
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    // Fault injection: the milestone finalize throws AFTER the rails
    // (listing/order/invoice/deposit-verified escrow hold) committed.
    const originalUpdate = ctx.contracts.updateMilestoneExpected.bind(ctx.contracts);
    vi.spyOn(ctx.contracts, 'updateMilestoneExpected').mockImplementation(
      async (id, patch, expected) => {
        if ('linkedLotId' in patch) {
          throw new Error('injected permanent commit failure');
        }
        return originalUpdate(id, patch, expected);
      }
    );
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput())
    ).rejects.toThrow('injected permanent commit failure');
    // Compensating unwind ran automatically:
    const [order] = (await ctx.orders.all()).filter((candidate) =>
      candidate.id.startsWith('order-offdel-')
    );
    expect(order.status).toBe('cancelled'); // no paid orphan order
    const [escrowRecord] = await ctx.escrows.all();
    expect(escrowRecord.status).toBe('refunded'); // buyer funds returned
    const [invoice] = await ctx.invoiceRepo.all();
    expect(invoice.status).toBe('cancelled');
    // The delivery claim row was removed — an honest retry never replays an orphan.
    expect(await ctx.contracts.listDeliveries(contract.id)).toHaveLength(0);
    // The milestone reservation rolled back.
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.deliveredQtyKg).toBe(0);
    expect(milestone?.status).toBe('pending');
    // The escrow-hold journal was reversed: both accounts net to zero.
    const buyerEscrow = await ctx.ledger.balance(buyerEscrowAccountCode(buyer.id));
    expect(buyerEscrow.debitsKobo).toBe(50_000_000);
    expect(buyerEscrow.creditsKobo).toBe(50_000_000);
    expect(buyerEscrow.balanceKobo).toBe(0);
    const liability = await ctx.ledger.balance(contractEscrowLiabilityAccountCode(contract.id));
    expect(liability.balanceKobo).toBe(0);
    await flushListeners();
    // The settlement sweep never settles a refunded (compensated) escrow.
    const sweep = await ctx.service.settlementSweep(admin);
    expect(sweep.redriven).toBe(0);
    expect(
      await ctx.ledger.findEntryByIdempotencyKey(`offtake-settle:${escrowRecord.id}`)
    ).toBeUndefined();
    // The same key is terminal (fail closed, no ambiguous reuse)...
    vi.restoreAllMocks();
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput())
    ).rejects.toThrow(/compensated/);
    // ...but a fresh idempotency key drives a clean new saga to success.
    const retry = await ctx.service.recordDelivery(
      coop,
      contract.id,
      deliveryInput({ idempotencyKey: 'del-key-retry', depositReference: 'dep-ref-retry' })
    );
    expect(retry.replay).toBe(false);
    expect((await ctx.contracts.milestoneBySeq(contract.id, 1))?.deliveredQtyKg).toBe(1_000);
  });

  it('settles on escrow release: DR contract liability, CR cooperative receivable (exactly once)', async () => {
    const ctx = makeService();
    ctx.service.onModuleInit(); // subscribe the settlement consumer
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    const result = await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const escrow = await ctx.escrow.escrowForOrder(result.order.id);
    await ctx.escrow.transition(escrow!.id, 'released', buyer);
    await flushListeners();
    const receivable = await ctx.ledger.balance(coopReceivableAccountCode(coop.id));
    expect(receivable.creditsKobo).toBe(50_000_000);
    const liability = await ctx.ledger.balance(contractEscrowLiabilityAccountCode(contract.id));
    expect(liability.debitsKobo).toBe(50_000_000);
    expect(liability.balanceKobo).toBe(0); // hold fully settled
    // A duplicate release event never double-posts (idempotency-keyed).
    await ctx.escrow.transition(escrow!.id, 'released', buyer);
    await flushListeners();
    expect((await ctx.ledger.balance(coopReceivableAccountCode(coop.id))).creditsKobo).toBe(50_000_000);
  });

  it('V-51: a dropped settlement listener is re-driven by the sweep to the identical journal', async () => {
    const ctx = makeService();
    ctx.service.onModuleInit(); // subscribe the settlement consumer
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    const result = await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const escrow = await ctx.escrow.escrowForOrder(result.order.id);
    // Fault injection: the settlement posting fails inside the listener;
    // the fire-and-forget catch swallows it and the event is consumed.
    const originalPost = ctx.ledger.postEntry.bind(ctx.ledger);
    let failSettlement = true;
    vi.spyOn(ctx.ledger, 'postEntry').mockImplementation(async (input, actorId) => {
      if (failSettlement && input.idempotencyKey.startsWith('offtake-settle:')) {
        throw new Error('injected ledger hiccup');
      }
      return originalPost(input, actorId);
    });
    await ctx.escrow.transition(escrow!.id, 'released', buyer);
    await flushListeners();
    // The settlement journal was dropped — only the sweep can recover it.
    expect(
      await ctx.ledger.findEntryByIdempotencyKey(`offtake-settle:${escrow!.id}`)
    ).toBeUndefined();
    failSettlement = false;
    // Non-admins may not run the sweep.
    await expect(ctx.service.settlementSweep(coop)).rejects.toThrow(ForbiddenException);
    // The sweep finds the released escrow without a journal and re-drives.
    const first = await ctx.service.settlementSweep(admin);
    expect(first.redriven).toBe(1);
    const entry = await ctx.ledger.findEntryByIdempotencyKey(`offtake-settle:${escrow!.id}`);
    expect(entry?.referenceId).toBe(escrow!.id);
    expect(entry?.postings).toEqual([
      {
        accountCode: contractEscrowLiabilityAccountCode(contract.id),
        direction: 'debit',
        amountKobo: 50_000_000
      },
      {
        accountCode: coopReceivableAccountCode(coop.id),
        direction: 'credit',
        amountKobo: 50_000_000
      }
    ]);
    // A repeated sweep converges — identical journal, no duplicate legs.
    const second = await ctx.service.settlementSweep(admin);
    expect(second.redriven).toBe(0);
    const legs = (await ctx.ledger.listEntries({ referenceId: escrow!.id })).filter((candidate) =>
      candidate.idempotencyKey.startsWith('offtake-settle:')
    );
    expect(legs).toHaveLength(1);
    expect((await ctx.ledger.balance(coopReceivableAccountCode(coop.id))).creditsKobo).toBe(
      50_000_000
    );
    const liability = await ctx.ledger.balance(contractEscrowLiabilityAccountCode(contract.id));
    expect(liability.balanceKobo).toBe(0);
  });
});

describe('OfftakeService views, sweep and collateral', () => {
  it("gives both parties the contract view and derives missed status at read time", async () => {
    const ctx = makeService();
    const { contract } = await activeContract(
      ctx,
      contractInput({
        qtyKg: 100,
        windowStart: '2020-01-01',
        windowEnd: '2020-12-31',
        milestones: [{ seq: 1, dueDate: '2020-06-30', qtyKg: 100 }]
      })
    );
    const view = await ctx.service.getContract(buyer, contract.id);
    expect(view.milestones[0].status).toBe('missed'); // due date long past
    expect((await ctx.contracts.milestoneBySeq(contract.id, 1))?.status).toBe('pending'); // persisted state untouched
    await expect(ctx.service.getContract(outsider, contract.id)).rejects.toThrow(NotFoundException);
  });

  it('sweeps missed milestones and defaults expired contracts (admin only, idempotent)', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(
      ctx,
      contractInput({
        qtyKg: 100,
        windowStart: '2020-01-01',
        windowEnd: '2020-12-31',
        milestones: [{ seq: 1, dueDate: '2020-06-30', qtyKg: 100 }]
      })
    );
    await expect(ctx.service.sweep(coop, '2021-01-01')).rejects.toThrow(ForbiddenException);
    const first = await ctx.service.sweep(admin, '2021-01-01');
    expect(first).toEqual({ missedMilestones: 1, defaultedContracts: 1 });
    const second = await ctx.service.sweep(admin, '2021-01-02');
    expect(second).toEqual({ missedMilestones: 0, defaultedContracts: 0 });
    expect((await ctx.contracts.getById(contract.id)).status).toBe('defaulted');
    expect((await ctx.contracts.milestoneBySeq(contract.id, 1))?.status).toBe('missed');
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.milestoneMissed);
    expect(names).toContain(OFFTAKE_EVENTS.defaulted);
  });

  it('exposes the read-only credit collateral view with honest totals', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const collateral = await ctx.service.collateralView(admin, contract.id);
    expect(collateral.totals.qtyKg).toBe(5_000);
    expect(collateral.totals.deliveredQtyKg).toBe(1_000);
    expect(collateral.totals.deliveredAmountKobo).toBe(50_000_000);
    expect(collateral.totals.milestoneCount).toBe(2);
    expect(collateral.totals.milestonesMet).toBe(0);
    await expect(ctx.service.collateralView(admin, 'offtake-missing')).rejects.toThrow(
      NotFoundException
    );
  });

  it('V-61: collateral view is scoped to contract parties + admin/regulator; everyone else 403', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(ctx);
    // Contract parties read their own collateral.
    await expect(ctx.service.collateralView(coop, contract.id)).resolves.toMatchObject({
      contract: { id: contract.id }
    });
    await expect(ctx.service.collateralView(buyer, contract.id)).resolves.toMatchObject({
      contract: { id: contract.id }
    });
    // Admin and regulator read any contract.
    const regulator = { id: 'user-regulator', roles: ['regulator'] } as User;
    await expect(ctx.service.collateralView(admin, contract.id)).resolves.toBeTruthy();
    await expect(ctx.service.collateralView(regulator, contract.id)).resolves.toBeTruthy();
    // Lender (deferred to V-31), donor, and unrelated users are refused.
    const donor = { id: 'user-donor', roles: ['donor'] } as User;
    await expect(ctx.service.collateralView(lender, contract.id)).rejects.toThrow(
      ForbiddenException
    );
    await expect(ctx.service.collateralView(donor, contract.id)).rejects.toThrow(
      ForbiddenException
    );
    await expect(ctx.service.collateralView(outsider, contract.id)).rejects.toThrow(
      ForbiddenException
    );
    await expect(ctx.service.collateralView(null, contract.id)).rejects.toThrow(
      'Authentication required'
    );
  });
});
