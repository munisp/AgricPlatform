import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  createInMemoryLedgerAccountRepository,
  createInMemoryLedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import type {
  LedgerBackendDriver,
  LedgerTransferResult
} from '../integrations/drivers/tigerbeetle.driver.js';
import { LedgerService } from './ledger.service.js';
import {
  parseTbAccountMap,
  TbConsistencyChecker,
  type TbPgAccountPair
} from './tb-consistency.checker.js';

/**
 * pg↔TigerBeetle consistency checker (WP-G13): inert under the stub backend,
 * fail-visible when tigerbeetle is selected but unverifiable, and exact on
 * balance comparison (pg Σ debits − Σ credits vs TB debits_posted −
 * credits_posted, integer kobo).
 */

const PAIR: TbPgAccountPair = { accountCode: 'vsla:group-1:cash', tbAccountId: '7001' };

function fakeBackend(options: {
  name: 'stub' | 'tigerbeetle';
  balances?: Record<string, { debitsPostedKobo: number; creditsPostedKobo: number }>;
  withLookup?: boolean;
}): LedgerBackendDriver {
  const base: LedgerBackendDriver = {
    name: options.name,
    postTransfer: (): Promise<LedgerTransferResult> =>
      Promise.reject(new Error('not used by the checker')),
    status: () =>
      Promise.resolve({ configured: true, healthy: true, detail: 'fake backend (test)' })
  };
  if (options.withLookup !== false) {
    base.lookupAccountBalances = (accountIds) =>
      Promise.resolve(
        accountIds.map((accountId) => {
          const found = options.balances?.[accountId];
          return found ? { accountId, ...found } : undefined;
        })
      );
  }
  return base;
}

async function makeWorld(backend?: LedgerBackendDriver) {
  const events = new DomainEventsService(createInMemoryOutboxRepository());
  const ledger = new LedgerService(
    events,
    createInMemoryLedgerAccountRepository(),
    createInMemoryLedgerEntryRepository()
  );
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const checker = new TbConsistencyChecker(
    ledger,
    backend,
    audit as unknown as AuditService
  );
  return { ledger, audit, checker };
}

/** Seeds a pg account with a 500_000 kobo debit balance. */
async function fundPgAccount(ledger: LedgerService, accountCode: string, amountKobo: number) {
  await ledger.ensureAccount({ code: accountCode, type: 'asset' });
  await ledger.postEntry(
    {
      idempotencyKey: `seed:${accountCode}:${amountKobo}`,
      description: 'checker fixture funding',
      postings: [
        { accountCode, direction: 'debit', amountKobo },
        { accountCode: 'platform:cash', direction: 'credit', amountKobo }
      ]
    },
    'test'
  );
}

describe('parseTbAccountMap', () => {
  it('parses a valid map and rejects malformed config (fail visible)', () => {
    expect(parseTbAccountMap(undefined)).toEqual([]);
    expect(parseTbAccountMap('')).toEqual([]);
    expect(parseTbAccountMap('[{"accountCode":"a:b","tbAccountId":"42"}]')).toEqual([
      { accountCode: 'a:b', tbAccountId: '42' }
    ]);
    expect(() => parseTbAccountMap('{not json')).toThrow(/not valid JSON/);
    expect(() => parseTbAccountMap('{"accountCode":"a"}')).toThrow(/JSON array/);
    expect(() => parseTbAccountMap('[{"accountCode":"a:b","tbAccountId":"x"}]')).toThrow(
      /decimal-string u128/
    );
  });
});

describe('TbConsistencyChecker (WP-G13)', () => {
  it('is inert under the stub backend (Postgres authoritative)', async () => {
    const { checker } = await makeWorld(fakeBackend({ name: 'stub' }));
    const report = await checker.runCheck([PAIR]);
    expect(report.enabled).toBe(false);
    expect(report.balanced).toBe(true);
    expect(report.checkedPairs).toBe(0);
  });

  it('is inert when no backend is bound at all', async () => {
    const { checker } = await makeWorld(undefined);
    const report = await checker.runCheck([PAIR]);
    expect(report.enabled).toBe(false);
  });

  it('tigerbeetle enabled with NO account map is itself an alert (never silently unverifiable)', async () => {
    const { checker, audit } = await makeWorld(fakeBackend({ name: 'tigerbeetle' }));
    const report = await checker.runCheck([], {});
    expect(report.enabled).toBe(true);
    expect(report.unmapped).toBe(true);
    expect(report.balanced).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'finance.ledger.tb_consistency_unmapped' })
    );
  });

  it('reads the map from TIGERBEETLE_ACCOUNT_MAP when no pairs are passed', async () => {
    const { ledger, checker } = await makeWorld(
      fakeBackend({
        name: 'tigerbeetle',
        balances: { '7001': { debitsPostedKobo: 500_000, creditsPostedKobo: 0 } }
      })
    );
    await fundPgAccount(ledger, PAIR.accountCode, 500_000);
    const report = await checker.runCheck(undefined, {
      TIGERBEETLE_ACCOUNT_MAP: JSON.stringify([PAIR])
    });
    expect(report.checkedPairs).toBe(1);
    expect(report.balanced).toBe(true);
    expect(report.divergent).toEqual([]);
  });

  it('agreeing balances report balanced', async () => {
    const { ledger, checker } = await makeWorld(
      fakeBackend({
        name: 'tigerbeetle',
        balances: { '7001': { debitsPostedKobo: 500_000, creditsPostedKobo: 0 } }
      })
    );
    await fundPgAccount(ledger, PAIR.accountCode, 500_000);
    const report = await checker.runCheck([PAIR]);
    expect(report.balanced).toBe(true);
    expect(report.divergent).toEqual([]);
  });

  it('a divergent pair is reported with the exact drift and audited', async () => {
    const { ledger, checker, audit } = await makeWorld(
      fakeBackend({
        name: 'tigerbeetle',
        balances: { '7001': { debitsPostedKobo: 400_000, creditsPostedKobo: 0 } }
      })
    );
    await fundPgAccount(ledger, PAIR.accountCode, 500_000);
    const report = await checker.runCheck([PAIR]);
    expect(report.balanced).toBe(false);
    expect(report.divergent).toEqual([
      expect.objectContaining({
        accountCode: PAIR.accountCode,
        tbAccountId: '7001',
        pgBalanceKobo: 500_000,
        tbBalanceKobo: 400_000,
        driftKobo: 100_000
      })
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'finance.ledger.tb_consistency_divergent' })
    );
  });

  it('a missing TB account is reported as divergence (never silently skipped)', async () => {
    const { ledger, checker } = await makeWorld(
      fakeBackend({ name: 'tigerbeetle', balances: {} })
    );
    await fundPgAccount(ledger, PAIR.accountCode, 500_000);
    const report = await checker.runCheck([PAIR]);
    expect(report.balanced).toBe(false);
    expect(report.divergent[0]).toMatchObject({ tbBalanceKobo: null, pgBalanceKobo: 500_000 });
  });

  it('a missing pg account is reported as divergence', async () => {
    const { checker } = await makeWorld(
      fakeBackend({
        name: 'tigerbeetle',
        balances: { '7001': { debitsPostedKobo: 0, creditsPostedKobo: 0 } }
      })
    );
    const report = await checker.runCheck([PAIR]);
    expect(report.balanced).toBe(false);
    expect(report.divergent[0]).toMatchObject({ pgBalanceKobo: null });
  });

  it('fails closed when the selected backend cannot answer balance lookups', async () => {
    const { checker } = await makeWorld(
      fakeBackend({ name: 'tigerbeetle', withLookup: false })
    );
    await expect(checker.runCheck([PAIR])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
