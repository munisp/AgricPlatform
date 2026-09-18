import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { warehouseOperatorBondAccountCode } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
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
import { createInMemoryCollateralPositionRepository } from '../../database/repositories/warehouse-ltv.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { H3Service } from '../geo/h3.service.js';
import { StubCertificationFeed } from './certification.driver.js';
import { StubCollateralRegistry } from './collateral-registry.driver.js';
import { WarehouseBondService } from './warehouse-bond.service.js';
import { WarehouseCollateralClaimService } from './collateral-claim.service.js';
import { WarehouseService } from './warehouse.service.js';

/**
 * V-39 (operator bond / fraud remedy, balanced draw) + V-31 warehouse half
 * (credit.collateral.claimed drives pledge release + balanced settlement
 * legs; spoiled receipts settle with the V-07 loss haircut).
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
  const bond = new WarehouseBondService(events, ledger, warehouses, service);
  const positions = createInMemoryCollateralPositionRepository();
  const claims = new WarehouseCollateralClaimService(
    events,
    ledger,
    service,
    receipts,
    pledges,
    positions
  );
  return { events, warehouses, deposits, receipts, pledges, ledger, service, bond, claims };
}

async function issuedReceipt(stack: ReturnType<typeof makeStack>) {
  const warehouse = await stack.service.registerWarehouse(
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
  const receipt = await stack.service.issueReceipt(deposit.id, admin);
  return { warehouse, receipt };
}

describe('V-39 operator bond / fraud remedy', () => {
  it('applies a pro-rata write-down and draws the bond with balanced legs', async () => {
    const stack = makeStack();
    const { warehouse, receipt } = await issuedReceipt(stack);
    await stack.bond.postBond(warehouse.id, 500_000, admin);
    const bondCode = warehouseOperatorBondAccountCode(warehouse.id);
    expect((await stack.ledger.balance(bondCode)).balanceKobo).toBe(-500_000); // liability

    const draw = await stack.bond.resolveFraudCase(
      warehouse.id,
      {
        caseId: 'FC-2026-001',
        compensationKobo: 200_000,
        writeDowns: [{ receiptId: receipt.id, lostWeightKg: 500, lostBagCount: 10 }]
      },
      admin
    );
    expect(draw.idempotencyKey).toBe(`warehouse-bond:draw:${warehouse.id}:FC-2026-001`);
    // Balanced: bond liability down 200k, compensation payable up 200k.
    expect((await stack.ledger.balance(bondCode)).balanceKobo).toBe(-300_000);
    expect(
      (await stack.ledger.balance(`warehouse:${warehouse.id}:fraud_compensation_payable`))
        .balanceKobo
    ).toBe(-200_000);
    // Pro-rata haircut applied to the receipt (V-07 machinery).
    const spoiled = await stack.receipts.getById(receipt.id);
    expect(spoiled.lostWeightKg).toBe(500);
    // Idempotent replay adopts the existing draw.
    const replay = await stack.bond.resolveFraudCase(
      warehouse.id,
      { caseId: 'FC-2026-001', compensationKobo: 200_000, writeDowns: [] },
      admin
    );
    expect(replay.id).toBe(draw.id);
  });

  it('fails closed when the bond does not cover the compensation, admin-only', async () => {
    const stack = makeStack();
    const { warehouse, receipt } = await issuedReceipt(stack);
    await stack.bond.postBond(warehouse.id, 100_000, admin);
    await expect(
      stack.bond.resolveFraudCase(
        warehouse.id,
        { caseId: 'FC-2', compensationKobo: 100_001, writeDowns: [] },
        admin
      )
    ).rejects.toThrowError(ConflictException);
    await expect(
      stack.bond.postBond(warehouse.id, 100_000, farmer)
    ).rejects.toThrowError(ForbiddenException);
    await expect(
      stack.bond.resolveFraudCase(
        warehouse.id,
        { caseId: 'FC-3', compensationKobo: 1, writeDowns: [{ receiptId: receipt.id }] },
        farmer
      )
    ).rejects.toThrowError(ForbiddenException);
  });
});

describe('V-31 warehouse half of credit.collateral.claimed', () => {
  it('drives pledge release and posts balanced settlement legs', async () => {
    const stack = makeStack();
    const { receipt } = await issuedReceipt(stack);
    const { pledge } = await stack.service.pledgeReceipt(
      receipt.id,
      { principalKobo: 300_000 },
      lender
    );
    const result = await stack.claims.handleCollateralClaimed(
      { collateralId: 'coll-1', loanId: 'loan-1', to: 'lender', receiptId: receipt.id, pledgeId: pledge.id },
      'system'
    );
    expect(result).toEqual({ handled: true, receiptId: receipt.id, settlementKobo: 300_000 });
    const after = await stack.receipts.getById(receipt.id);
    expect(after.status).toBe('released');
    expect((await stack.pledges.getById(pledge.id)).status).toBe('released');
    // Balanced settlement legs: lender receivable == borrower write-off.
    expect(
      (await stack.ledger.balance(`member:${lender.id}:whr_claims_receivable`)).balanceKobo
    ).toBe(300_000);
    expect(
      (await stack.ledger.balance(`member:${farmer.id}:whr_collateral_settlement`)).balanceKobo
    ).toBe(-300_000);
    // Idempotent replay: no second settlement entry.
    const replay = await stack.claims.handleCollateralClaimed(
      { collateralId: 'coll-1', loanId: 'loan-1', to: 'lender', receiptId: receipt.id, pledgeId: pledge.id },
      'system'
    );
    expect(replay.handled).toBe(true);
    expect(
      (await stack.ledger.balance(`member:${lender.id}:whr_claims_receivable`)).balanceKobo
    ).toBe(300_000);
  });

  it('applies the V-07 loss haircut: a spoiled receipt settles below principal', async () => {
    const stack = makeStack();
    const { receipt } = await issuedReceipt(stack);
    const { pledge } = await stack.service.pledgeReceipt(
      receipt.id,
      { principalKobo: 300_000 },
      lender
    );
    await stack.service.reportLoss(
      receipt.id,
      { kind: 'spoilage', lostWeightKg: 800, reason: 'silo fire', lostBagCount: 16 },
      admin
    );
    const result = await stack.claims.handleCollateralClaimed(
      { collateralId: 'coll-9', loanId: 'loan-9', receiptId: receipt.id, pledgeId: pledge.id },
      'system'
    );
    // 40% of the grain (800/2000 kg) is gone → the claim settles at 60% of principal.
    expect(result.settlementKobo).toBe(180_000);
  });

  it('ignores claims that carry no receipt/pledge/loan reference', async () => {
    const stack = makeStack();
    const result = await stack.claims.handleCollateralClaimed(
      { collateralId: 'coll-x', to: 'lender' },
      'system'
    );
    expect(result.handled).toBe(false);
  });

  it('the credit.collateral.claimed EVENT drives the pledge release + settlement (subscription path)', async () => {
    const stack = makeStack();
    const { receipt } = await issuedReceipt(stack);
    await stack.service.pledgeReceipt(receipt.id, { principalKobo: 250_000 }, lender);
    // Wire the subscription exactly as Nest does on module init.
    stack.claims.onModuleInit();
    await stack.events.publish(
      'credit.collateral.claimed',
      { collateralId: 'coll-evt-1', loanId: 'loan-evt-1', to: 'lender', receiptId: receipt.id },
      'system'
    );
    // The listener is fire-and-forget inside the fan-out; yield to the
    // event loop until the handler chain (release → legs) has settled.
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect((await stack.receipts.getById(receipt.id)).status).toBe('released');
    expect(
      (await stack.ledger.balance(`member:${lender.id}:whr_claims_receivable`)).balanceKobo
    ).toBe(250_000);
    expect(
      (await stack.ledger.balance(`member:${farmer.id}:whr_collateral_settlement`)).balanceKobo
    ).toBe(-250_000);
  });
});
