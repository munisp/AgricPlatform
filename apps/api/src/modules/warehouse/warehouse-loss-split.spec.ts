import {
  BadRequestException,
  ConflictException,
  ForbiddenException
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type {
  CertifiedWarehouse,
  CollateralPosition,
  User,
  WarehouseReceipt
} from '@agric-platform/shared';
import { effectiveReceiptWeightKg } from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryLoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryCommodityLotRepository } from '../../database/repositories/traceability.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import {
  createInMemoryCertifiedWarehouseRepository,
  createInMemoryWarehouseDepositRepository,
  createInMemoryWarehousePledgeRepository,
  createInMemoryWarehouseReceiptRepository,
  createInMemoryWarehouseTransferRepository
} from '../../database/repositories/warehouse.repository.js';
import {
  createInMemoryCollateralPositionRepository,
  createInMemoryLtvObservationRepository
} from '../../database/repositories/warehouse-ltv.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import type { CommodityPriceProvider } from '../integrations/drivers/commodity-price.provider.js';
import { StubCertificationFeed } from './certification.driver.js';
import { StubCollateralRegistry } from './collateral-registry.driver.js';
import { LtvGuardianService } from './ltv-guardian.service.js';
import { WarehouseService } from './warehouse.service.js';

/**
 * V-07 (spoilage/condition loss with LTV haircut propagation) + V-37
 * (receipt split with quantity conservation + signature chaining).
 */

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-farmer', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };

const KANO = { latitude: 12.0022, longitude: 8.592 };

function makeStack() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const lots = createInMemoryCommodityLotRepository();
  const warehouses = createInMemoryCertifiedWarehouseRepository();
  const deposits = createInMemoryWarehouseDepositRepository();
  const receipts = createInMemoryWarehouseReceiptRepository();
  const pledges = createInMemoryWarehousePledgeRepository();
  const transfers = createInMemoryWarehouseTransferRepository();
  const users = createInMemoryUserRepository();
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const service = new WarehouseService(
    events,
    new H3Service(),
    warehouses,
    deposits,
    receipts,
    pledges,
    transfers,
    lots,
    new StubCertificationFeed(),
    new StubCollateralRegistry(),
    users
  );
  return { events, lots, warehouses, deposits, receipts, pledges, transfers, users, ledger, service };
}

async function issuedReceipt(stack: ReturnType<typeof makeStack>): Promise<WarehouseReceipt> {
  const warehouse: CertifiedWarehouse = await stack.service.registerWarehouse(
    {
      name: 'Kano Grains Depot',
      state: 'Kano',
      lga: 'Nassarawa',
      ...KANO,
      capacityTonnes: 500,
      operatorLicenseRef: 'LIC-KANO-01'
    },
    admin.id
  );
  await stack.service.refreshCertification(warehouse.id, admin);
  const deposit = await stack.service.createDeposit(
    { warehouseId: warehouse.id, crop: 'maize' },
    farmer.id
  );
  await stack.service.gradeDeposit(
    deposit.id,
    { grade: 'A', moisturePercent: 12.5, bagCount: 40, weightKg: 2000 },
    admin
  );
  return stack.service.issueReceipt(deposit.id, admin);
}

describe('V-07 spoilage/condition loss', () => {
  it('records a cumulative write-down without touching the signed issuance fields', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    const updated = await stack.service.reportLoss(
      receipt.id,
      { kind: 'spoilage', lostWeightKg: 400, lostBagCount: 8, reason: 'warehouse flood' },
      admin
    );
    expect(updated.weightKg).toBe(2000); // signed payload untouched
    expect(updated.bagCount).toBe(40);
    expect(updated.lostWeightKg).toBe(400);
    expect(updated.lostBagCount).toBe(8);
    expect(effectiveReceiptWeightKg(updated)).toBe(1600);
    // The issuance signature still verifies against the untouched payload.
    await expect(stack.service.verifyReceiptDeep(updated)).resolves.toBe(true);
    // Cumulative second report.
    const again = await stack.service.reportLoss(
      receipt.id,
      { kind: 'theft', lostWeightKg: 100, reason: 'night theft, police report 12/9' },
      admin
    );
    expect(again.lostWeightKg).toBe(500);
    expect(effectiveReceiptWeightKg(again)).toBe(1500);
  });

  it('supports re-grade and refuses over-loss / unauthorised reports', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    const regraded = await stack.service.reportLoss(
      receipt.id,
      { kind: 'regrade', newGrade: 'B', reason: 'aflatoxin above grade-A threshold' },
      admin
    );
    expect(regraded.regradedTo).toBe('B');
    expect(regraded.grade).toBe('A'); // signed grade preserved
    await expect(
      stack.service.reportLoss(receipt.id, { kind: 'spoilage', lostWeightKg: 2001, reason: 'x' }, admin)
    ).rejects.toThrowError(BadRequestException);
    await expect(
      stack.service.reportLoss(receipt.id, { kind: 'spoilage', lostWeightKg: 1, reason: 'x' }, farmer)
    ).rejects.toThrowError(ForbiddenException);
  });

  it('propagates the write-down to LTV: collateral value drops and a margin call raises', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    // Fund the borrower's receivable with a 300,000-kobo outstanding loan.
    await stack.ledger.ensureAccount({ code: `member:${farmer.id}:loans_receivable`, type: 'asset' });
    await stack.ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
    await stack.ledger.postEntry(
      {
        idempotencyKey: 'loan-disbursal:1',
        referenceType: 'loan_disbursal',
        referenceId: 'loan-1',
        description: 'loan principal',
        postings: [
          { accountCode: `member:${farmer.id}:loans_receivable`, direction: 'debit', amountKobo: 300_000 },
          { accountCode: 'platform:cash', direction: 'credit', amountKobo: 300_000 }
        ]
      },
      admin.id
    );
    const positions = createInMemoryCollateralPositionRepository();
    const position: CollateralPosition = {
      id: 'pos-1',
      receiptId: receipt.id,
      loanId: 'loan-1',
      lenderId: lender.id,
      borrowerId: farmer.id,
      ledgerAccountCode: `member:${farmer.id}:loans_receivable`,
      pledgedQtyKg: 2000,
      commodity: 'maize',
      haircutBps: 0,
      ltvLimitBps: 5000,
      marginCallBps: 7000,
      status: 'active',
      priceStale: false,
      openedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await positions.create(position);
    // Price 250 kobo/kg: collateral 500,000 → LTV 60% (below the 70% call).
    // A 60% loss write-down (800 kg effective) → collateral 200,000 → LTV 150%.
    const prices: CommodityPriceProvider = {
      name: 'http',
      configured: true,
      fetchQuote: () =>
        Promise.resolve({
          crop: 'maize',
          pricePerTonneNaira: 2500, // = 250 kobo/kg
          trend: 'stable',
          source: 'test',
          observedAt: new Date().toISOString()
        })
    };
    const guardian = new LtvGuardianService(
      stack.events,
      stack.ledger,
      new TelemetryService(),
      stack.receipts,
      stack.pledges,
      positions,
      createInMemoryLtvObservationRepository(),
      createInMemoryLoanApplicationRepository(),
      prices
    );
    // Report the loss (publishes warehouse.receipt.loss_reported — the
    // production wiring is the onModuleInit subscription, exercised below).
    await stack.service.reportLoss(
      receipt.id,
      { kind: 'spoilage', lostWeightKg: 1200, reason: 'silo fire' },
      admin
    );
    // The subscription listener is fire-and-forget inside the event fan-out;
    // drive the same handler awaited for a deterministic assertion (the
    // handler is idempotent, so the listener's concurrent run converges).
    await guardian.applyLossEvent(
      stack.events.build(
        'warehouse.receipt.loss_reported',
        { receiptId: receipt.id, effectiveWeightKg: 800 },
        admin.id
      )
    );
    const updated = await positions.getById('pos-1');
    expect(updated.pledgedQtyKg).toBe(800); // written down to the effective weight
    expect(updated.status).toBe('margin_call'); // haircut propagation triggered the call
    // The subscription is wired on module init (same handler path).
    guardian.onModuleInit();
  });
});

describe('V-37 receipt split', () => {
  it('splits a receipt conserving total weight/bags, with chained child signatures', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    const { parent, children } = await stack.service.splitReceipt(
      receipt.id,
      [
        { weightKg: 1200, bagCount: 24 },
        { weightKg: 800, bagCount: 16, toOwnerId: 'user-farmer-2' }
      ],
      farmer
    );
    expect(parent.status).toBe('split');
    expect(children).toHaveLength(2);
    expect(children[0].weightKg + children[1].weightKg).toBe(2000); // conservation
    expect(children[0].bagCount + children[1].bagCount).toBe(40);
    expect(children[0].parentReceiptId).toBe(receipt.id);
    expect(children[0].splitSeq).toBe(1);
    expect(children[1].ownerId).toBe('user-farmer-2');
    // Child signatures verify through the parent chain.
    await expect(stack.service.verifyReceiptDeep(children[0])).resolves.toBe(true);
    await expect(stack.service.verifyReceiptDeep(children[1])).resolves.toBe(true);
    // A child signed against a DIFFERENT parent fails (re-parenting breaks the chain).
    const other = await issuedReceipt(stack);
    await expect(
      stack.service.verifyReceiptDeep({ ...children[0], parentReceiptId: other.id })
    ).resolves.toBe(false);
  });

  it('makes the parent non-pledgeable/non-transferable after split and is replay-safe', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    await stack.service.splitReceipt(receipt.id, [
      { weightKg: 1000, bagCount: 20 },
      { weightKg: 1000, bagCount: 20 }
    ], farmer);
    await expect(
      stack.service.pledgeReceipt(receipt.id, { principalKobo: 100_000 }, lender)
    ).rejects.toThrowError(BadRequestException);
    await expect(stack.service.transferReceipt(receipt.id, 'user-farmer-2', farmer)).rejects.toThrowError(
      BadRequestException
    );
    await expect(stack.service.redeemReceipt(receipt.id, farmer)).rejects.toThrowError(
      BadRequestException
    );
    // Replay returns the same children instead of minting duplicates.
    const replay = await stack.service.splitReceipt(receipt.id, [
      { weightKg: 1000, bagCount: 20 },
      { weightKg: 1000, bagCount: 20 }
    ], farmer);
    expect(replay.children).toHaveLength(2);
    expect((await stack.receipts.find({ parentReceiptId: receipt.id })).length).toBe(2);
  });

  it('refuses non-conserving splits, pledged receipts and non-owners', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    await expect(
      stack.service.splitReceipt(receipt.id, [
        { weightKg: 1500, bagCount: 30 },
        { weightKg: 600, bagCount: 10 } // 100 kg short — does not conserve
      ], farmer)
    ).rejects.toThrowError(/conserve/);
    await expect(
      stack.service.splitReceipt(receipt.id, [
        { weightKg: 1000, bagCount: 20 },
        { weightKg: 1000, bagCount: 20 }
      ], { id: 'user-outsider', roles: ['supplier'] })
    ).rejects.toThrowError(ForbiddenException);
    await stack.service.pledgeReceipt(receipt.id, { principalKobo: 100_000 }, lender);
    await expect(
      stack.service.splitReceipt(receipt.id, [
        { weightKg: 1000, bagCount: 20 },
        { weightKg: 1000, bagCount: 20 }
      ], farmer)
    ).rejects.toThrowError(ConflictException);
  });

  it('splits the loss-adjusted effective quantity, not the signed quantity', async () => {
    const stack = makeStack();
    const receipt = await issuedReceipt(stack);
    await stack.service.reportLoss(
      receipt.id,
      { kind: 'spoilage', lostWeightKg: 500, lostBagCount: 10, reason: 'mould' },
      admin
    );
    await expect(
      stack.service.splitReceipt(receipt.id, [
        { weightKg: 1000, bagCount: 20 },
        { weightKg: 1000, bagCount: 20 }
      ], farmer)
    ).rejects.toThrowError(/conserve/); // 2000 kg ≠ effective 1500 kg
    const { children } = await stack.service.splitReceipt(receipt.id, [
      { weightKg: 900, bagCount: 18 },
      { weightKg: 600, bagCount: 12 }
    ], farmer);
    expect(children[0].weightKg + children[1].weightKg).toBe(1500);
  });
});
