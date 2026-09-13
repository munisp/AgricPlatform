import { describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOrderRepository } from '../../database/repositories/order.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerReconciliationService } from '../finance/ledger-reconciliation.service.js';
import { LedgerService } from '../finance/ledger.service.js';
import {
  ESCROW_HOLDS_LIABILITY_ACCOUNT,
  ESCROW_PROVIDER_FLOAT_ACCOUNT,
  escrowHoldLedgerKey,
  escrowMoneyOutLedgerKey
} from './escrow-ledger.js';
import { EscrowService } from './escrow.service.js';

/**
 * Escrow double-entry ledger legs (Stage 27, WP-G13 ledger hardening): every
 * hold posts DR provider_float / CR holds_liability, every release/refund
 * posts the settlement leg, all idempotency-keyed per escrow, and the
 * reconciliation sweep detects/repairs any missing leg so escrow value can
 * never drift from the ledger silently.
 *
 * Uses seed order 'order-buyer-cassava' (₦370,000, escrowRequired), like
 * escrow.service.spec.ts.
 */

const buyer: Pick<User, 'id' | 'roles'> = { id: 'user-buyer', roles: ['buyer'] };
const seller: Pick<User, 'id' | 'roles'> = { id: 'user-adamu', roles: ['farmer'] };

function makeWorld(options?: { withLedger?: boolean }) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const entries = createInMemoryLedgerEntryRepository();
  const escrows = createInMemoryEscrowRepository();
  const ledger =
    options?.withLedger === false
      ? undefined
      : new LedgerService(events, createInMemoryLedgerAccountRepository(), entries);
  const service = new EscrowService(
    events,
    createInMemoryOrderRepository(),
    escrows,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ledger
  );
  const reconciliation = new LedgerReconciliationService(ledger!, entries, escrows);
  return { events, entries, escrows, ledger, service, reconciliation };
}

async function liabilityOutstanding(ledger: LedgerService): Promise<number> {
  const balance = await ledger.balance(ESCROW_HOLDS_LIABILITY_ACCOUNT);
  return balance.creditsKobo - balance.debitsKobo;
}

describe('EscrowService ledger legs (WP-G13)', () => {
  it('a hold posts the balanced hold leg (DR provider float, CR holds liability)', async () => {
    const { service, ledger } = makeWorld();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id as string);

    const leg = await ledger!.findEntryByIdempotencyKey(escrowHoldLedgerKey(record.id));
    expect(leg).toBeDefined();
    expect(leg?.referenceType).toBe('marketplace_escrow_hold');
    expect(leg?.referenceId).toBe(record.id);
    expect(leg?.postings).toEqual([
      { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'debit', amountKobo: 37_000_000 },
      { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'credit', amountKobo: 37_000_000 }
    ]);
    // The invariant: open holds Σ === liability outstanding === float balance.
    expect(await liabilityOutstanding(ledger!)).toBe(37_000_000);
    expect((await ledger!.balance(ESCROW_PROVIDER_FLOAT_ACCOUNT)).balanceKobo).toBe(37_000_000);
  });

  it('hold replays never double-post the leg', async () => {
    const { service, entries } = makeWorld();
    const first = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    const second = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    expect(second.id).toBe(first.id);
    const legs = await entries.find({ referenceType: 'marketplace_escrow_hold' });
    expect(legs).toHaveLength(1);
  });

  it('a release settles the liability on-ledger (balances net to zero)', async () => {
    const { service, ledger, entries } = makeWorld();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    await service.transition(record.id, 'released', buyer);

    const leg = await ledger!.findEntryByIdempotencyKey(
      escrowMoneyOutLedgerKey('released', record.id)
    );
    expect(leg?.referenceType).toBe('marketplace_escrow_release');
    expect(leg?.postings).toEqual([
      { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'debit', amountKobo: 37_000_000 },
      { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'credit', amountKobo: 37_000_000 }
    ]);
    expect(await liabilityOutstanding(ledger!)).toBe(0);
    expect((await ledger!.balance(ESCROW_PROVIDER_FLOAT_ACCOUNT)).balanceKobo).toBe(0);
    expect(await entries.find({})).toHaveLength(2); // hold + release, exactly
  });

  it('a refund settles the liability with its own keyed leg', async () => {
    const { service, ledger } = makeWorld();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    await service.transition(record.id, 'refunded', seller);
    const leg = await ledger!.findEntryByIdempotencyKey(
      escrowMoneyOutLedgerKey('refunded', record.id)
    );
    expect(leg?.referenceType).toBe('marketplace_escrow_refund');
    expect(await liabilityOutstanding(ledger!)).toBe(0);
  });

  it('a leg-posting failure surfaces honestly and the transition replay re-ensures the leg', async () => {
    const { service, ledger, entries } = makeWorld();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    // Sabotage exactly one posting (the settlement leg) after the terminal
    // state write would commit.
    const original = ledger!.postEntry.bind(ledger!);
    let sabotaged = true;
    ledger!.postEntry = ((input: Parameters<LedgerService['postEntry']>[0], actorId: string) =>
      sabotaged && input.idempotencyKey.startsWith('escrow-ledger:released:')
        ? Promise.reject(new Error('ledger write failed'))
        : original(input, actorId)) as LedgerService['postEntry'];

    await expect(service.transition(record.id, 'released', buyer)).rejects.toThrow(
      'ledger write failed'
    );
    // The escrow reached its terminal state; the leg is missing (drift).
    expect((await service.escrowForOrder('order-buyer-cassava'))?.status).toBe('released');
    expect(
      await ledger!.findEntryByIdempotencyKey(escrowMoneyOutLedgerKey('released', record.id))
    ).toBeUndefined();

    // The idempotent replay branch re-ensures the leg and converges.
    sabotaged = false;
    const replay = await service.transition(record.id, 'released', buyer);
    expect(replay.status).toBe('released');
    expect(
      await ledger!.findEntryByIdempotencyKey(escrowMoneyOutLedgerKey('released', record.id))
    ).toBeDefined();
    expect(await entries.find({})).toHaveLength(2);
    expect(await liabilityOutstanding(ledger!)).toBe(0);
  });
});

describe('Escrow reconciliation (WP-G13)', () => {
  it('an empty world reconciles balanced', async () => {
    const { reconciliation } = makeWorld();
    const report = await reconciliation.reconcileEscrow({ repair: false });
    expect(report.balanced).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.checkedEscrows).toBe(0);
  });

  it('a healthy hold + release reconciles balanced', async () => {
    const { service, reconciliation } = makeWorld();
    const record = await service.holdForOrder('order-buyer-cassava', buyer.id as string);
    await service.transition(record.id, 'released', buyer);
    const report = await reconciliation.reconcileEscrow({ repair: false });
    expect(report.balanced).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.openHoldsKobo).toBe(0);
    expect(report.holdsLiabilityKobo).toBe(0);
  });

  it('detects a pre-WP-G13 escrow with no legs, and repair backfills them (idempotent)', async () => {
    // Legacy world: the escrow moved with NO ledger wired — no legs exist.
    const legacy = makeWorld({ withLedger: false });
    const record = await legacy.service.holdForOrder('order-buyer-cassava', buyer.id as string);
    expect(record.status).toBe('held');

    // Reconcile with a ledger over the SAME escrow repository: the missing
    // hold leg is drift, and the aggregate diverges.
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const entries = createInMemoryLedgerEntryRepository();
    const ledger = new LedgerService(
      events,
      createInMemoryLedgerAccountRepository(),
      entries
    );
    const reconciliation = new LedgerReconciliationService(ledger, entries, legacy.escrows);
    const detected = await reconciliation.reconcileEscrow({ repair: false });
    expect(detected.balanced).toBe(false);
    expect(detected.drift.map((item) => item.issue)).toContain('missing_hold_leg');
    expect(detected.openHoldsKobo).toBe(37_000_000);
    expect(detected.holdsLiabilityKobo).toBe(0);

    const repaired = await reconciliation.reconcileEscrow({ repair: true });
    expect(repaired.repairedCount).toBe(1);
    expect(repaired.balanced).toBe(true);
    expect(repaired.holdsLiabilityKobo).toBe(37_000_000);
    // Repair is idempotent: a second repair posts nothing new.
    const again = await reconciliation.reconcileEscrow({ repair: true });
    expect(again.repairedCount).toBe(0);
    expect(again.balanced).toBe(true);
    expect(await entries.find({})).toHaveLength(1);
  });

  it('a leg amount mismatch is alert-only (never auto-repaired)', async () => {
    // Legacy hold without a ledger; the recon world then holds a CORRUPT
    // entry under the escrow's canonical hold key (amount differs from the
    // record). The keyed replay returns it, so repair must NOT overwrite it.
    const legacy = makeWorld({ withLedger: false });
    const record = await legacy.service.holdForOrder('order-buyer-cassava', buyer.id as string);
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    const entries = createInMemoryLedgerEntryRepository();
    const ledger = new LedgerService(events, createInMemoryLedgerAccountRepository(), entries);
    const reconciliation = new LedgerReconciliationService(ledger, entries, legacy.escrows);
    await postCorruptHoldLeg(ledger, record.id, 100);
    const report = await reconciliation.reconcileEscrow({ repair: true });
    expect(report.balanced).toBe(false);
    const mismatch = report.drift.find(
      (item) => item.issue === 'leg_amount_mismatch' && item.escrowId === record.id
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.repaired).toBe(false);
    // The corrupt entry was NOT replaced.
    expect(
      (await ledger.findEntryByIdempotencyKey(escrowHoldLedgerKey(record.id)))?.postings[0]
        .amountKobo
    ).toBe(100);
  });

  it('an orphan ledger entry (no escrow record) is alert-only drift', async () => {
    const { reconciliation, ledger } = makeWorld();
    await ledger!.ensureAccount({ code: ESCROW_PROVIDER_FLOAT_ACCOUNT, type: 'asset' });
    await ledger!.ensureAccount({ code: ESCROW_HOLDS_LIABILITY_ACCOUNT, type: 'liability' });
    await ledger!.postEntry(
      {
        idempotencyKey: escrowHoldLedgerKey('escrow-ghost'),
        referenceType: 'marketplace_escrow_hold',
        referenceId: 'escrow-ghost',
        description: 'orphan',
        postings: [
          { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'debit', amountKobo: 500 },
          { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'credit', amountKobo: 500 }
        ]
      },
      'test'
    );
    const report = await reconciliation.reconcileEscrow({ repair: true });
    expect(report.balanced).toBe(false);
    // The orphan is reported and never repaired (the aggregate necessarily
    // diverges as well — the orphan leg moved the pooled accounts).
    expect(report.drift).toContainEqual(
      expect.objectContaining({
        escrowId: 'escrow-ghost',
        issue: 'orphan_ledger_entry',
        repaired: false
      })
    );
  });
});

/** Posts a hold leg under the canonical key with a corrupted amount. */
async function postCorruptHoldLeg(
  ledger: LedgerService,
  escrowId: string,
  amountKobo: number
): Promise<void> {
  await ledger.ensureAccount({ code: ESCROW_PROVIDER_FLOAT_ACCOUNT, type: 'asset' });
  await ledger.ensureAccount({ code: ESCROW_HOLDS_LIABILITY_ACCOUNT, type: 'liability' });
  await ledger.postEntry(
    {
      idempotencyKey: escrowHoldLedgerKey(escrowId),
      referenceType: 'marketplace_escrow_hold',
      referenceId: escrowId,
      description: 'corrupt canonical leg',
      postings: [
        { accountCode: ESCROW_PROVIDER_FLOAT_ACCOUNT, direction: 'debit', amountKobo },
        { accountCode: ESCROW_HOLDS_LIABILITY_ACCOUNT, direction: 'credit', amountKobo }
      ]
    },
    'test'
  );
}
