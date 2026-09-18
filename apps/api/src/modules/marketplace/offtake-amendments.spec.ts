import {
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Profile, User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryInvoiceRepository } from '../../database/repositories/invoice.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryListingRepository } from '../../database/repositories/listing.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOfftakeContractRepository } from '../../database/repositories/offtake.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryReviewRepository } from '../../database/repositories/review.repository.js';
import { createInMemoryCommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import type { ProfilesService } from '../profiles/profiles.service.js';
import type { CommodityLot } from '../traceability/traceability.types.js';
import { EscrowService } from './escrow.service.js';
import { InvoiceService } from './invoice.service.js';
import { MarketplaceService } from './marketplace.service.js';
import {
  buyerPenaltyPayableAccountCode,
  coopPenaltyReceivableAccountCode,
  defaultPenaltyKobo
} from './offtake.js';
import {
  OFFTAKE_EVENTS,
  OfftakeService,
  type CreateOfftakeContractInput,
  type RecordDeliveryInput
} from './offtake.service.js';

/**
 * V-34 (offtake renegotiation: versioned propose/accept amendments; the
 * sweep respects amended deadlines) + V-35 (buyer-default remedy: penalty
 * receivable leg + stranded-lot re-marketing linkage).
 */

const coop = { id: 'user-coop', roles: ['chapter_lead'] } as User;
const buyer = { id: 'user-buyer', roles: ['buyer'] } as User;
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

function makeService() {
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
    }
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

async function activeContract(ctx: ReturnType<typeof makeService>) {
  const { contract, milestones } = await ctx.service.createContract(coop, contractInput());
  const accepted = await ctx.service.accept(buyer, contract.id);
  return { contract: accepted, milestones };
}

describe('V-34 offtake renegotiation (contract amendments)', () => {
  it('amendment round-trip re-bands the price: a refused price settles after acceptance', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);

    // 70,000 kobo/kg is outside the contracted [40,000..60,000] band.
    await expect(
      ctx.service.recordDelivery(coop, contract.id, deliveryInput({ priceKoboPerKg: 70_000 }))
    ).rejects.toThrowError(/band/);
    let names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.renegotiationRequired);

    // Buyer proposes a re-banded price; the cooperative (counterparty) accepts.
    const amendment = await ctx.service.proposeAmendment(buyer, contract.id, {
      priceBand: { floorKoboPerKg: 65_000, capKoboPerKg: 75_000 },
      note: 'market moved; re-band'
    });
    expect(amendment.status).toBe('proposed');
    const { contract: amended } = await ctx.service.acceptAmendment(coop, contract.id, amendment.id);
    expect(amended.termsVersion).toBe(2);
    expect(amended.priceBand).toEqual({ floorKoboPerKg: 65_000, capKoboPerKg: 75_000 });

    // The same delivery now settles inside the amended band.
    const delivery = await ctx.service.recordDelivery(
      coop,
      contract.id,
      deliveryInput({ priceKoboPerKg: 70_000 })
    );
    expect(delivery.delivery.priceKoboPerKg).toBe(70_000);
    names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.amendmentProposed);
    expect(names).toContain(OFFTAKE_EVENTS.amendmentAccepted);
  });

  it('sweep respects amended deadlines: re-dated milestones/window do not miss/default', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(ctx);
    // Extend the window to 2028 and re-date milestone 1.
    const amendment = await ctx.service.proposeAmendment(coop, contract.id, {
      windowEnd: '2028-06-30',
      milestoneDueDates: [
        { seq: 1, dueDate: '2028-03-31' },
        { seq: 2, dueDate: '2028-06-30' }
      ]
    });
    await ctx.service.acceptAmendment(buyer, contract.id, amendment.id);
    // At the ORIGINAL deadlines (2027) nothing is missed or defaulted.
    const sweep1 = await ctx.service.sweep(admin, '2027-08-01');
    expect(sweep1).toEqual({ missedMilestones: 0, defaultedContracts: 0 });
    const sweep2 = await ctx.service.sweep(admin, '2028-01-15');
    expect(sweep2).toEqual({ missedMilestones: 0, defaultedContracts: 0 });
    // Past the AMENDED deadlines the sweep applies normally.
    const sweep3 = await ctx.service.sweep(admin, '2028-07-01');
    expect(sweep3).toEqual({ missedMilestones: 2, defaultedContracts: 1 });
  });

  it('enforces bilateral acceptance, supersession and party scoping', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(ctx);
    await expect(
      ctx.service.proposeAmendment(outsider, contract.id, {
        priceBand: { floorKoboPerKg: 1, capKoboPerKg: 2 }
      })
    ).rejects.toThrowError(NotFoundException);
    const first = await ctx.service.proposeAmendment(coop, contract.id, {
      priceBand: { floorKoboPerKg: 45_000, capKoboPerKg: 55_000 }
    });
    // The proposer cannot accept their own amendment.
    await expect(ctx.service.acceptAmendment(coop, contract.id, first.id)).rejects.toThrowError(
      ForbiddenException
    );
    // A second proposal supersedes the first.
    const second = await ctx.service.proposeAmendment(buyer, contract.id, {
      windowEnd: '2028-01-31'
    });
    expect((await ctx.contracts.amendmentById(first.id))?.status).toBe('superseded');
    await expect(ctx.service.acceptAmendment(coop, contract.id, first.id)).rejects.toThrowError(
      ConflictException
    );
    const accepted = await ctx.service.acceptAmendment(coop, contract.id, second.id);
    expect(accepted.contract.windowEnd).toBe('2028-01-31');
    expect(accepted.contract.priceBand).toEqual(contract.priceBand); // unchanged term preserved
    // Accept replay is idempotent.
    const replay = await ctx.service.acceptAmendment(buyer, contract.id, second.id);
    expect(replay.amendment.status).toBe('accepted');
  });

  it('revives a freshly-missed milestone when the amendment re-dates it forward', async () => {
    const ctx = makeService();
    const { contract } = await activeContract(ctx);
    const missed = await ctx.service.sweep(admin, '2027-07-15');
    expect(missed.missedMilestones).toBe(1); // milestone 1 missed (2027-06-30)
    const amendment = await ctx.service.proposeAmendment(buyer, contract.id, {
      milestoneDueDates: [{ seq: 1, dueDate: '2027-09-30' }]
    });
    await ctx.service.acceptAmendment(coop, contract.id, amendment.id);
    const milestone = await ctx.contracts.milestoneBySeq(contract.id, 1);
    expect(milestone?.status).toBe('pending'); // revived, re-dated
    expect(milestone?.dueDate).toBe('2027-09-30');
  });
});

describe('V-35 buyer-default remedy', () => {
  it('a defaulted contract records the penalty receivable and links the stranded lot to a new listing', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    const { contract } = await activeContract(ctx);
    // Partial delivery of milestone 1 (1,000 of 2,000 kg, lot-1 linked).
    await ctx.service.recordDelivery(coop, contract.id, deliveryInput());
    const result = await ctx.service.sweep(admin, '2028-01-15');
    expect(result.defaultedContracts).toBe(1);

    const defaulted = await ctx.contracts.getById(contract.id);
    expect(defaulted.status).toBe('defaulted');
    // Undelivered = (2,000 - 1,000) + 3,000 = 4,000 kg at floor 40,000
    // kobo/kg × 10% penalty = 16,000,000 kobo.
    const expectedPenalty = defaultPenaltyKobo(contract, 4_000);
    expect(expectedPenalty).toBe(16_000_000);
    expect(defaulted.defaultPenaltyKobo).toBe(16_000_000);
    // Balanced penalty legs: coop asset (debit) == buyer liability (credit).
    const receivable = await ctx.ledger.balance(coopPenaltyReceivableAccountCode(coop.id));
    const payable = await ctx.ledger.balance(buyerPenaltyPayableAccountCode(buyer.id));
    expect(receivable.debitsKobo - receivable.creditsKobo).toBe(16_000_000);
    expect(payable.creditsKobo - payable.debitsKobo).toBe(16_000_000);
    // Assisted re-marketing: stranded lot → new active listing at the floor.
    expect(defaulted.remarketedListingId).toBeDefined();
    const listing = await ctx.listings.getById(defaulted.remarketedListingId!);
    expect(listing.sellerId).toBe(coop.id);
    expect(listing.quantity).toBe(4_000);
    expect(listing.isActive).toBe(true);
    expect(listing.priceNaira).toBe(400); // 40,000 kobo/kg
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).toContain(OFFTAKE_EVENTS.defaultRemedy);

    // The sweep is idempotent: a second run does not re-default or double-post.
    const again = await ctx.service.sweep(admin, '2028-01-16');
    expect(again.defaultedContracts).toBe(0);
    const receivableAfter = await ctx.ledger.balance(coopPenaltyReceivableAccountCode(coop.id));
    expect(receivableAfter.debitsKobo).toBe(receivable.debitsKobo);
  });

  it('a fully-delivered contract defaults without a remedy when nothing is stranded', async () => {
    const ctx = makeService();
    await ctx.lots.create(makeLot('lot-1'));
    await ctx.lots.create(makeLot('lot-2'));
    const { contract } = await activeContract(ctx);
    await ctx.service.recordDelivery(coop, contract.id, deliveryInput({ qtyKg: 2_000 }));
    await ctx.service.recordDelivery(
      coop,
      contract.id,
      deliveryInput({ milestoneSeq: 2, lotId: 'lot-2', qtyKg: 3_000, idempotencyKey: 'del-key-2', depositReference: 'dep-ref-2' })
    );
    expect((await ctx.contracts.getById(contract.id)).status).toBe('fulfilled');
    const result = await ctx.service.sweep(admin, '2028-01-15');
    expect(result.defaultedContracts).toBe(0); // fulfilled, not defaulted
    const names = (await ctx.events.listOutbox()).map((event) => event.name);
    expect(names).not.toContain(OFFTAKE_EVENTS.defaultRemedy);
  });
});
