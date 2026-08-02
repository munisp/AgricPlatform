import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { LedgerService } from './ledger.service.js';

const ADMIN = 'user-admin';

function makeService() {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const service = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  return { service, events };
}

function balancedPostings(amountKobo: number) {
  return [
    { accountCode: 'platform:cash', direction: 'debit' as const, amountKobo },
    { accountCode: 'platform:interest_income', direction: 'credit' as const, amountKobo }
  ];
}

describe('LedgerService', () => {
  it('posts a balanced entry and computes balances in integer kobo', async () => {
    const { service } = makeService();
    const entry = await service.postEntry(
      { idempotencyKey: 'k1', description: 'test posting', postings: balancedPostings(125_000) },
      ADMIN
    );
    expect(entry.postings).toHaveLength(2);
    const cash = await service.balance('platform:cash');
    expect(cash).toEqual({
      accountCode: 'platform:cash',
      debitsKobo: 125_000,
      creditsKobo: 0,
      balanceKobo: 125_000
    });
    const income = await service.balance('platform:interest_income');
    expect(income.balanceKobo).toBe(-125_000);
    expect((await service.entriesForAccount('platform:cash')).map((e) => e.id)).toEqual([entry.id]);
  });

  it('rejects unbalanced entries (SUM(debits) must equal SUM(credits))', async () => {
    const { service } = makeService();
    await expect(
      service.postEntry(
        {
          idempotencyKey: 'k-unbalanced',
          postings: [
            { accountCode: 'platform:cash', direction: 'debit', amountKobo: 100 },
            { accountCode: 'platform:interest_income', direction: 'credit', amountKobo: 99 }
          ]
        },
        ADMIN
      )
    ).rejects.toThrowError(/Unbalanced journal entry/);
  });

  it('rejects entries with fewer than two postings', async () => {
    const { service } = makeService();
    await expect(
      service.postEntry(
        {
          idempotencyKey: 'k-single',
          postings: [{ accountCode: 'platform:cash', direction: 'debit', amountKobo: 100 }]
        },
        ADMIN
      )
    ).rejects.toThrowError(/at least two postings/);
  });

  it('rejects float, zero and negative kobo amounts', async () => {
    const { service } = makeService();
    for (const amountKobo of [1.5, 0, -100]) {
      await expect(
        service.postEntry(
          {
            idempotencyKey: `k-${amountKobo}`,
            postings: [
              { accountCode: 'platform:cash', direction: 'debit', amountKobo },
              { accountCode: 'platform:interest_income', direction: 'credit', amountKobo }
            ]
          },
          ADMIN
        )
      ).rejects.toThrowError(/positive integer kobo/);
    }
  });

  it('rejects postings to unknown accounts', async () => {
    const { service } = makeService();
    await expect(
      service.postEntry(
        {
          idempotencyKey: 'k-unknown',
          postings: [
            { accountCode: 'platform:cash', direction: 'debit', amountKobo: 100 },
            { accountCode: 'nowhere:missing', direction: 'credit', amountKobo: 100 }
          ]
        },
        ADMIN
      )
    ).rejects.toThrowError(NotFoundException);
  });

  it('replays idempotency keys instead of double-posting', async () => {
    const { service } = makeService();
    const first = await service.postEntry({ idempotencyKey: 'k1', postings: balancedPostings(500) }, ADMIN);
    const replay = await service.postEntry({ idempotencyKey: 'k1', postings: balancedPostings(500) }, ADMIN);
    expect(replay.id).toBe(first.id);
    expect((await service.balance('platform:cash')).debitsKobo).toBe(500);
  });

  it('keeps entries immutable: reversals are counter-entries', async () => {
    const { service } = makeService();
    const original = await service.postEntry(
      { idempotencyKey: 'k1', postings: balancedPostings(75_000) },
      ADMIN
    );
    const reversal = await service.reverseEntry(original.id, ADMIN);
    expect(reversal.reversesEntryId).toBe(original.id);
    expect(reversal.postings).toEqual([
      { accountCode: 'platform:cash', direction: 'credit', amountKobo: 75_000 },
      { accountCode: 'platform:interest_income', direction: 'debit', amountKobo: 75_000 }
    ]);
    // Net effect on balances is zero.
    expect((await service.balance('platform:cash')).balanceKobo).toBe(0);
    // Original untouched; reversal is idempotent and cannot be re-reversed.
    expect((await service.getEntry(original.id)).reversesEntryId).toBeUndefined();
    expect((await service.reverseEntry(original.id, ADMIN)).id).toBe(reversal.id);
    await expect(service.reverseEntry(reversal.id, ADMIN)).rejects.toThrowError(
      BadRequestException
    );
  });

  it('provisions accounts idempotently and rejects duplicate codes', async () => {
    const { service } = makeService();
    const account = await service.ensureAccount({
      code: 'member:user-adamu:wallet',
      type: 'liability',
      ownerId: 'user-adamu'
    });
    expect((await service.ensureAccount({ code: 'member:user-adamu:wallet', type: 'liability' })).id).toBe(
      account.id
    );
    await expect(
      service.createAccount({ code: 'member:user-adamu:wallet', type: 'liability' })
    ).rejects.toThrowError(ConflictException);
  });
});
