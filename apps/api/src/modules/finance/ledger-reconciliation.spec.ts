import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { LedgerJournalEntry } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  assertBalancedEntry,
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryEscrowRepository } from '../../database/repositories/escrow.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerReconciliationService } from './ledger-reconciliation.service.js';
import { LedgerService } from './ledger.service.js';

/**
 * WP-G13 (Stage 27, ledger hardening) — persistence-level balance invariant
 * on the in-memory ledger repository (mirrors the pg in-transaction
 * assertion; the pg twin lives in test/pg/ledger-balance-enforcement.pg.spec.ts)
 * plus the unbalanced-transfer drift detector.
 */

function entry(overrides: Partial<LedgerJournalEntry> = {}): LedgerJournalEntry {
  return {
    id: 'entry-1',
    idempotencyKey: 'key-1',
    referenceType: 'test',
    postedAt: new Date().toISOString(),
    postings: [
      { accountCode: 'a:x', direction: 'debit', amountKobo: 100 },
      { accountCode: 'a:y', direction: 'credit', amountKobo: 100 }
    ],
    ...overrides
  };
}

function makeWorld() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const entries = createInMemoryLedgerEntryRepository();
  const ledger = new LedgerService(events, createInMemoryLedgerAccountRepository(), entries);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const reconciliation = new LedgerReconciliationService(
    ledger,
    entries,
    createInMemoryEscrowRepository(),
    audit as unknown as AuditService
  );
  return { entries, reconciliation, audit };
}

describe('InMemoryLedgerEntryRepository balance enforcement (WP-G13)', () => {
  it('rejects an unbalanced entry at the repository (regression: previously accepted)', async () => {
    const { entries } = makeWorld();
    await expect(
      entries.postEntry(
        entry({
          postings: [
            { accountCode: 'a:x', direction: 'debit', amountKobo: 100 },
            { accountCode: 'a:y', direction: 'credit', amountKobo: 99 }
          ]
        })
      )
    ).rejects.toThrowError(BadRequestException);
    // Nothing persisted: the failed posting leaves no trace.
    expect(await entries.find({})).toHaveLength(0);
  });

  it('rejects fewer than two postings (a single-sided or empty transfer balances trivially in SQL)', async () => {
    const { entries } = makeWorld();
    await expect(
      entries.postEntry(
        entry({ postings: [{ accountCode: 'a:x', direction: 'debit', amountKobo: 100 }] })
      )
    ).rejects.toThrowError(/minimum 2/);
    await expect(entries.postEntry(entry({ postings: [] }))).rejects.toThrowError(/minimum 2/);
  });

  it('rejects non-positive or non-integer kobo amounts', async () => {
    const { entries } = makeWorld();
    await expect(
      entries.postEntry(
        entry({
          postings: [
            { accountCode: 'a:x', direction: 'debit', amountKobo: 1.5 },
            { accountCode: 'a:y', direction: 'credit', amountKobo: 1.5 }
          ]
        })
      )
    ).rejects.toThrowError(/positive integer kobo/);
  });

  it('accepts a balanced entry', async () => {
    const { entries } = makeWorld();
    await expect(entries.postEntry(entry())).resolves.toMatchObject({ id: 'entry-1' });
  });
});

describe('LedgerReconciliationService unbalanced-transfer detection (WP-G13)', () => {
  it('reports zero drift for a healthy ledger, without alerting', async () => {
    const { entries, reconciliation, audit } = makeWorld();
    await entries.postEntry(entry());
    const unbalanced = await reconciliation.findUnbalancedEntries();
    expect(unbalanced).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('detects an unbalanced entry that bypassed the guarded posting path (drift alert)', async () => {
    const { entries, reconciliation, audit } = makeWorld();
    // Simulate a direct-SQL writer / corruption: insert an unbalanced entry
    // BEHIND the repository's back (postEntry would refuse it).
    const rogue = entry({
      id: 'entry-rogue',
      idempotencyKey: 'rogue',
      postings: [{ accountCode: 'a:x', direction: 'debit', amountKobo: 100 }]
    });
    (entries as unknown as { items: Map<string, LedgerJournalEntry> }).items.set(
      rogue.id,
      rogue
    );
    const unbalanced = await reconciliation.findUnbalancedEntries();
    expect(unbalanced.map((item) => item.id)).toEqual(['entry-rogue']);
    // Fail visible: audit row records the drift.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'finance.ledger.unbalanced_detected',
        metadata: expect.objectContaining({ count: 1, entryIds: ['entry-rogue'] })
      })
    );
  });

  it('assertBalancedEntry is the same invariant the pg path checks via transfer_is_balanced', () => {
    expect(() => assertBalancedEntry(entry())).not.toThrow();
    expect(() =>
      assertBalancedEntry(
        entry({
          postings: [
            { accountCode: 'a:x', direction: 'debit', amountKobo: 100 },
            { accountCode: 'a:y', direction: 'credit', amountKobo: 50 },
            { accountCode: 'a:z', direction: 'credit', amountKobo: 50 }
          ]
        })
      )
    ).not.toThrow();
    expect(() =>
      assertBalancedEntry(
        entry({
          postings: [
            { accountCode: 'a:x', direction: 'debit', amountKobo: 100 },
            { accountCode: 'a:y', direction: 'credit', amountKobo: 50 }
          ]
        })
      )
    ).toThrowError(BadRequestException);
  });
});
