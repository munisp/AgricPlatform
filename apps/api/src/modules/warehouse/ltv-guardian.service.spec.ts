import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type {
  CollateralPosition,
  LoanApplication,
  User,
  WarehousePledge,
  WarehouseReceipt
} from '@agric-platform/shared';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryLoanApplicationRepository } from '../../database/repositories/loan.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  createInMemoryCollateralPositionRepository,
  createInMemoryLtvObservationRepository
} from '../../database/repositories/warehouse-ltv.repository.js';
import {
  InMemoryWarehousePledgeRepository,
  InMemoryWarehouseReceiptRepository
} from '../../database/repositories/warehouse.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import type {
  CommodityPriceProvider,
  CommodityPriceQuote
} from '../integrations/drivers/commodity-price.provider.js';
import { LtvGuardianService, type AttachMonitorInput } from './ltv-guardian.service.js';

const farmer: Pick<User, 'id' | 'roles'> = { id: 'user-farmer', roles: ['farmer'] };
const lender: Pick<User, 'id' | 'roles'> = { id: 'user-lender', roles: ['lender'] };
const otherLender: Pick<User, 'id' | 'roles'> = { id: 'user-lender-2', roles: ['lender'] };
const admin: Pick<User, 'id' | 'roles'> = { id: 'user-admin', roles: ['admin'] };
const outsider: Pick<User, 'id' | 'roles'> = { id: 'user-outsider', roles: ['supplier'] };

const RECEIVABLE = `member:${farmer.id}:loans_receivable`;

const NOW = '2026-09-12T00:00:00.000Z';

function receiptFixture(status: WarehouseReceipt['status'] = 'pledged'): WarehouseReceipt {
  return {
    id: 'receipt-1',
    receiptNumber: 'WHR-2026-TEST001',
    depositId: 'deposit-1',
    warehouseId: 'warehouse-1',
    ownerId: farmer.id,
    crop: 'maize',
    grade: 'A',
    bagCount: 40,
    weightKg: 2000,
    status,
    nonce: 'nonce-1',
    signature: 'sig-1',
    issuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function pledgeFixture(): WarehousePledge {
  return {
    id: 'pledge-1',
    receiptId: 'receipt-1',
    lenderId: lender.id,
    borrowerId: farmer.id,
    principalKobo: 300_000,
    terms: '',
    status: 'active',
    registryBasis: 'stub',
    registeredAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function loanFixture(overrides: Partial<LoanApplication> = {}): LoanApplication {
  return {
    id: 'loan-1',
    applicantId: farmer.id,
    lenderId: lender.id,
    amountKobo: 300_000,
    termMonths: 6,
    annualRateBps: 2750,
    status: 'disbursed',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

const ATTACH: AttachMonitorInput = {
  loanId: 'loan-1',
  pledgedQtyKg: 2000,
  commodity: 'maize',
  haircutBps: 2000,
  ltvLimitBps: 6000,
  marginCallBps: 8000
};

/** Deterministic quote provider whose name controls the basis label. */
function quoteProvider(name: string, pricePerTonneNaira: number): CommodityPriceProvider {
  return {
    name,
    configured: true,
    fetchQuote: (crop: string): Promise<CommodityPriceQuote> =>
      Promise.resolve({
        crop,
        pricePerTonneNaira,
        trend: 'stable',
        source: `test-${name}`,
        observedAt: NOW
      })
  };
}

/** Mirrors the production unconfigured driver: fetch always 503s. */
function failingProvider(): CommodityPriceProvider {
  return {
    name: 'unconfigured',
    configured: false,
    fetchQuote: () =>
      Promise.reject(
        new ServiceUnavailableException('No commodity price provider is configured.')
      )
  };
}

function makeService(options: {
  provider: CommodityPriceProvider;
  receipt?: WarehouseReceipt;
  pledge?: WarehousePledge;
  loan?: LoanApplication;
}) {
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const telemetry = new TelemetryService();
  const receipts = new InMemoryWarehouseReceiptRepository([
    options.receipt ?? receiptFixture()
  ]);
  const pledges = new InMemoryWarehousePledgeRepository([options.pledge ?? pledgeFixture()]);
  const positions = createInMemoryCollateralPositionRepository();
  const observations = createInMemoryLtvObservationRepository();
  const loans = createInMemoryLoanApplicationRepository();
  void loans.create(options.loan ?? loanFixture());
  const service = new LtvGuardianService(
    events,
    ledger,
    telemetry,
    receipts,
    pledges,
    positions,
    observations,
    loans,
    options.provider
  );
  return { service, events, outbox, ledger, telemetry, receipts, pledges, positions, observations, loans };
}

/**
 * Funds the ledger exactly like finance/loan.service.ts disbursement:
 * platform cash is capitalised, then the loan posts member receivable debit
 * / platform cash credit with the solvency guard.
 */
async function disburseViaLedger(ledger: LedgerService, outstandingKobo = 300_000): Promise<void> {
  await ledger.ensureAccount({ code: 'platform:cash', type: 'asset' });
  await ledger.ensureAccount({ code: 'platform:equity', type: 'equity' });
  await ledger.ensureAccount({ code: RECEIVABLE, type: 'asset', ownerId: farmer.id });
  await ledger.postEntry(
    {
      idempotencyKey: 'test-capitalise-cash',
      postings: [
        { accountCode: 'platform:cash', direction: 'debit', amountKobo: 10_000_000 },
        { accountCode: 'platform:equity', direction: 'credit', amountKobo: 10_000_000 }
      ]
    },
    'test'
  );
  await ledger.postEntry(
    {
      idempotencyKey: 'loan-disbursement:loan-1',
      referenceType: 'loan_application',
      referenceId: 'loan-1',
      postings: [
        { accountCode: RECEIVABLE, direction: 'debit', amountKobo: outstandingKobo },
        { accountCode: 'platform:cash', direction: 'credit', amountKobo: outstandingKobo }
      ],
      requireSolventAccounts: ['platform:cash']
    },
    'test'
  );
}

async function attach(harness: ReturnType<typeof makeService>): Promise<CollateralPosition> {
  await disburseViaLedger(harness.ledger);
  return harness.service.attachMonitor('receipt-1', ATTACH, lender);
}

const eventNames = (outbox: ReturnType<typeof createInMemoryOutboxRepository>) =>
  outbox.list().then((events) => events.map((event) => event.name));

describe('LtvGuardianService.attachMonitor', () => {
  it('opens an active position linked to the ledger receivable account', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    const position = await attach(harness);
    expect(position.status).toBe('active');
    expect(position.priceStale).toBe(false);
    expect(position.ledgerAccountCode).toBe(RECEIVABLE);
    expect(position.commodity).toBe('maize');
    expect(position.lenderId).toBe(lender.id);
    expect(position.borrowerId).toBe(farmer.id);
    expect(await eventNames(harness.outbox)).toContain('warehouse.position.opened');
  });

  it('rejects a receipt that is not pledged', async () => {
    const harness = makeService({
      provider: quoteProvider('http', 40_000),
      receipt: receiptFixture('active')
    });
    await disburseViaLedger(harness.ledger);
    await expect(harness.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      BadRequestException
    );
  });

  it('rejects a lender who does not hold the pledge', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    await disburseViaLedger(harness.ledger);
    await expect(harness.service.attachMonitor('receipt-1', ATTACH, otherLender)).rejects.toThrow(
      ForbiddenException
    );
  });

  it('lets an admin attach on behalf of the pledge lender', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    const position = await (async () => {
      await disburseViaLedger(harness.ledger);
      return harness.service.attachMonitor('receipt-1', ATTACH, admin);
    })();
    expect(position.lenderId).toBe(lender.id);
  });

  it('rejects a loan that is not disbursed yet', async () => {
    const harness = makeService({
      provider: quoteProvider('http', 40_000),
      loan: loanFixture({ status: 'approved' })
    });
    await disburseViaLedger(harness.ledger);
    await expect(harness.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      BadRequestException
    );
  });

  it('rejects lender/borrower mismatch between loan and pledge', async () => {
    const wrongLender = makeService({
      provider: quoteProvider('http', 40_000),
      loan: loanFixture({ lenderId: otherLender.id })
    });
    await disburseViaLedger(wrongLender.ledger);
    await expect(wrongLender.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      BadRequestException
    );
    const wrongBorrower = makeService({
      provider: quoteProvider('http', 40_000),
      loan: loanFixture({ applicantId: 'user-someone-else' })
    });
    await disburseViaLedger(wrongBorrower.ledger);
    await expect(wrongBorrower.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      BadRequestException
    );
  });

  it('rejects monitoring a commodity that is not the receipt crop', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    await disburseViaLedger(harness.ledger);
    await expect(
      harness.service.attachMonitor('receipt-1', { ...ATTACH, commodity: 'sorghum' }, lender)
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects pledging more than the receipt weight', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    await disburseViaLedger(harness.ledger);
    await expect(
      harness.service.attachMonitor('receipt-1', { ...ATTACH, pledgedQtyKg: 2000.01 }, lender)
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects invalid thresholds (haircut 10000, margin below limit)', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    await disburseViaLedger(harness.ledger);
    await expect(
      harness.service.attachMonitor('receipt-1', { ...ATTACH, haircutBps: 10_000 }, lender)
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.attachMonitor(
        'receipt-1',
        { ...ATTACH, ltvLimitBps: 6000, marginCallBps: 5000 },
        lender
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('fails closed when the loan has no ledger footprint', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    // No disburseViaLedger: the receivable account does not exist.
    await expect(harness.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      BadRequestException
    );
    expect(await harness.positions.all()).toHaveLength(0);
  });

  it('enforces one live position per receipt (409 on the second attach)', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    await attach(harness);
    await expect(harness.service.attachMonitor('receipt-1', ATTACH, lender)).rejects.toThrow(
      ConflictException
    );
  });

  it('allows re-monitoring after the previous episode cured', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    const first = await attach(harness);
    await harness.positions.update(first.id, { status: 'cured', closedAt: NOW });
    const second = await harness.service.attachMonitor('receipt-1', ATTACH, lender);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('active');
  });
});

describe('LtvGuardianService evaluation — price tick via stub provider', () => {
  it('records a stub-labelled observation and emits warehouse.ltv.observed', async () => {
    const harness = makeService({ provider: quoteProvider('fixture', 40_000) });
    const position = await attach(harness);
    const result = await harness.service.evaluatePosition(position, lender.id);
    expect(result.outcome).toBe('observed');
    expect(result.priceBasis).toBe('stub');
    // 4,000 kobo/kg: gross 8,000,000 × 0.8 = 6,400,000; 300,000 ÷ 6,400,000 → 469 bps.
    expect(result.ltvBps).toBe(469);
    const observations = await harness.observations.find({ positionId: position.id });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      positionId: position.id,
      pricePerKgKobo: 4000,
      priceBasis: 'stub',
      outstandingKobo: 300_000,
      ltvBps: 469
    });
    expect(await eventNames(harness.outbox)).toContain('warehouse.ltv.observed');
  });

  it('NEVER raises a margin call from stub prices, even deep in breach', async () => {
    // ₦2,000/tonne → 200 kobo/kg → ltv 9375 bps, far above the 8000 limit.
    const harness = makeService({ provider: quoteProvider('fixture', 2000) });
    const position = await attach(harness);
    const result = await harness.service.evaluatePosition(position, lender.id);
    expect(result.outcome).toBe('observed');
    expect(result.ltvBps).toBe(9375);
    const stored = await harness.positions.getById(position.id);
    expect(stored.status).toBe('active');
    expect(await eventNames(harness.outbox)).not.toContain('warehouse.margin_call.raised');
  });
});

describe('LtvGuardianService evaluation — live prices move state', () => {
  it('raises a margin call exactly once when a live price breaches the threshold', async () => {
    const harness = makeService({ provider: quoteProvider('http', 2000) });
    const position = await attach(harness);
    const raised = await harness.service.evaluatePosition(position, lender.id);
    expect(raised.outcome).toBe('margin_call_raised');
    expect(raised.ltvBps).toBe(9375);
    expect((await harness.positions.getById(position.id)).status).toBe('margin_call');

    // Second evaluation at the same breaching price: no re-raise.
    const again = await harness.service.evaluatePosition(
      await harness.positions.getById(position.id),
      lender.id
    );
    expect(again.outcome).toBe('unchanged');
    const names = await eventNames(harness.outbox);
    expect(names.filter((name) => name === 'warehouse.margin_call.raised')).toHaveLength(1);
  });

  it('concurrent evaluations cannot double-raise (CAS from active)', async () => {
    const harness = makeService({ provider: quoteProvider('http', 2000) });
    const position = await attach(harness);
    await Promise.all([
      harness.service.evaluatePosition(position, lender.id),
      harness.service.evaluatePosition(position, lender.id)
    ]);
    const names = await eventNames(harness.outbox);
    expect(names.filter((name) => name === 'warehouse.margin_call.raised')).toHaveLength(1);
    expect((await harness.positions.getById(position.id)).status).toBe('margin_call');
  });

  it('cures the margin call when the live LTV recovers within the limit', async () => {
    let current = quoteProvider('http', 2000);
    const delegating: CommodityPriceProvider = {
      get name() {
        return current.name;
      },
      get configured() {
        return current.configured;
      },
      fetchQuote: (crop, state) => current.fetchQuote(crop, state)
    };
    const harness = makeService({ provider: delegating });
    const position = await attach(harness);
    await harness.service.evaluatePosition(position, lender.id);
    expect((await harness.positions.getById(position.id)).status).toBe('margin_call');

    current = quoteProvider('http', 40_000);
    const cured = await harness.service.evaluatePosition(
      await harness.positions.getById(position.id),
      lender.id
    );
    expect(cured.outcome).toBe('cured');
    expect(cured.ltvBps).toBe(469);
    const stored = await harness.positions.getById(position.id);
    expect(stored.status).toBe('cured');
    expect(stored.closedAt).toBeDefined();
    const names = await eventNames(harness.outbox);
    expect(names).toContain('warehouse.margin_call.cured');
    expect(names.filter((name) => name === 'warehouse.margin_call.raised')).toHaveLength(1);
  });

  it('watch-band erosion on an active position changes nothing', async () => {
    // ₦2,800/tonne → 280 kobo/kg → 6696 bps: above the 6000 limit, below 8000.
    const harness = makeService({ provider: quoteProvider('http', 2800) });
    const position = await attach(harness);
    const result = await harness.service.evaluatePosition(position, lender.id);
    expect(result.outcome).toBe('unchanged');
    expect(result.ltvBps).toBe(6696);
    expect((await harness.positions.getById(position.id)).status).toBe('active');
    expect(await eventNames(harness.outbox)).not.toContain('warehouse.margin_call.raised');
  });
});

describe('LtvGuardianService evaluation — fail-closed on unavailable prices', () => {
  it('skips the position, records NO observation, flags price_stale', async () => {
    const harness = makeService({ provider: failingProvider() });
    const position = await attach(harness);
    const increment = vi.spyOn(harness.telemetry, 'increment');
    const result = await harness.service.evaluatePosition(position, lender.id);
    expect(result.outcome).toBe('unavailable');
    expect(result.priceBasis).toBe('unavailable');
    expect(await harness.observations.find({ positionId: position.id })).toHaveLength(0);
    const stored = await harness.positions.getById(position.id);
    expect(stored.priceStale).toBe(true);
    expect(stored.status).toBe('active');
    expect(increment).toHaveBeenCalledWith(
      'warehouse.ltv_evaluations_total',
      1,
      expect.objectContaining({ basis: 'unavailable' })
    );
    const names = await eventNames(harness.outbox);
    expect(names).not.toContain('warehouse.ltv.observed');
    expect(names).not.toContain('warehouse.margin_call.raised');
  });

  it('clears price_stale once a real quote succeeds again', async () => {
    let current: CommodityPriceProvider = failingProvider();
    const delegating: CommodityPriceProvider = {
      get name() {
        return current.name;
      },
      get configured() {
        return current.configured;
      },
      fetchQuote: (crop, state) => current.fetchQuote(crop, state)
    };
    const harness = makeService({ provider: delegating });
    const position = await attach(harness);
    await harness.service.evaluatePosition(position, lender.id);
    expect((await harness.positions.getById(position.id)).priceStale).toBe(true);

    current = quoteProvider('fixture', 40_000);
    const recovered = await harness.service.evaluatePosition(
      await harness.positions.getById(position.id),
      lender.id
    );
    expect(recovered.outcome).toBe('observed');
    const stored = await harness.positions.getById(position.id);
    expect(stored.priceStale).toBe(false);
    expect(await harness.observations.find({ positionId: position.id })).toHaveLength(1);
  });
});

describe('LtvGuardianService — outstanding comes from the ledger', () => {
  it('a repayment posting lowers the next observation’s LTV', async () => {
    const harness = makeService({ provider: quoteProvider('fixture', 40_000) });
    const position = await attach(harness);
    await harness.service.evaluatePosition(position, lender.id);
    // Repay ₦1,000 (100,000 kobo): platform cash debit / receivable credit.
    await harness.ledger.postEntry(
      {
        idempotencyKey: 'loan-repayment:loan-1:1',
        referenceType: 'loan_application',
        referenceId: 'loan-1',
        postings: [
          { accountCode: 'platform:cash', direction: 'debit', amountKobo: 100_000 },
          { accountCode: RECEIVABLE, direction: 'credit', amountKobo: 100_000 }
        ]
      },
      farmer.id
    );
    await harness.service.evaluatePosition(
      await harness.positions.getById(position.id),
      lender.id
    );
    const observations = await harness.observations.find({ positionId: position.id });
    expect(observations).toHaveLength(2);
    expect(observations[0]?.outstandingKobo).toBe(300_000);
    expect(observations[1]?.outstandingKobo).toBe(200_000);
    // 200,000 ÷ 6,400,000 × 10000 = 312.5 → 313 bps (was 469).
    expect(observations[1]?.ltvBps).toBe(313);
  });
});

describe('LtvGuardianService.runEvaluation', () => {
  it('evaluates every live position and aggregates the summary', async () => {
    const harness = makeService({ provider: quoteProvider('http', 2000) });
    await attach(harness);
    const summary = await harness.service.runEvaluation(admin.id);
    expect(summary.evaluated).toBe(1);
    expect(summary.observed).toBe(1);
    expect(summary.marginCallsRaised).toBe(1);
    expect(summary.unavailable).toBe(0);
    expect(summary.results[0]?.outcome).toBe('margin_call_raised');
  });

  it('skips cured positions and isolates unavailable feeds', async () => {
    const harness = makeService({ provider: failingProvider() });
    const position = await attach(harness);
    await harness.positions.update(position.id, { status: 'cured', closedAt: NOW });
    const summary = await harness.service.runEvaluation(admin.id);
    expect(summary.evaluated).toBe(0);

    await harness.positions.update(position.id, { status: 'active', closedAt: undefined });
    const degraded = await harness.service.runEvaluation(admin.id);
    expect(degraded.evaluated).toBe(1);
    expect(degraded.unavailable).toBe(1);
    expect((await harness.positions.getById(position.id)).priceStale).toBe(true);
  });
});

describe('LtvGuardianService.getPosition', () => {
  it('returns the position with observation history, newest first', async () => {
    const harness = makeService({ provider: quoteProvider('fixture', 40_000) });
    const position = await attach(harness);
    await harness.service.evaluatePosition(position, lender.id);
    await harness.service.evaluatePosition(position, lender.id);
    const detail = await harness.service.getPosition(position.id, lender);
    expect(detail.position.id).toBe(position.id);
    expect(detail.observations).toHaveLength(2);
    expect(
      detail.observations[0]!.observedAt >= detail.observations[1]!.observedAt
    ).toBe(true);
  });

  it('is visible to the borrower and oversight, not outsiders', async () => {
    const harness = makeService({ provider: quoteProvider('fixture', 40_000) });
    const position = await attach(harness);
    await expect(harness.service.getPosition(position.id, farmer)).resolves.toBeDefined();
    await expect(
      harness.service.getPosition(position.id, { id: 'user-regulator', roles: ['regulator'] })
    ).resolves.toBeDefined();
    await expect(harness.service.getPosition(position.id, outsider)).rejects.toThrow(
      ForbiddenException
    );
  });
});

describe('append-only + CAS repository contracts', () => {
  it('the observation port exposes no update/remove surface', async () => {
    const harness = makeService({ provider: quoteProvider('fixture', 40_000) });
    const position = await attach(harness);
    await harness.service.evaluatePosition(position, lender.id);
    await harness.service.evaluatePosition(position, lender.id);
    const observations = await harness.observations.find({ positionId: position.id });
    expect(observations).toHaveLength(2);
    const repo = harness.observations as unknown as Record<string, unknown>;
    expect(repo.update).toBeUndefined();
    expect(repo.remove).toBeUndefined();
    expect(repo.updateExpected).toBeUndefined();
  });

  it('position CAS rejects a stale precondition (margin-call race)', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    const position = await attach(harness);
    await harness.positions.updateExpected(
      position.id,
      { status: 'margin_call', updatedAt: NOW },
      { status: 'active' }
    );
    await expect(
      harness.positions.updateExpected(
        position.id,
        { status: 'margin_call', updatedAt: NOW },
        { status: 'active' }
      )
    ).rejects.toThrow(ConflictException);
  });

  it('in-memory create mirrors the pg one-live-position-per-receipt index', async () => {
    const harness = makeService({ provider: quoteProvider('http', 40_000) });
    const position = await attach(harness);
    await expect(
      harness.positions.create({ ...position, id: 'whcollat-duplicate' })
    ).rejects.toThrow(ConflictException);
  });
});
