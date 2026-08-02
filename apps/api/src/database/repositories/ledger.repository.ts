import type {
  LedgerAccount,
  LedgerAccountType,
  LedgerBalance,
  LedgerJournalEntry
} from '@agric-platform/shared';
import { BadRequestException } from '@nestjs/common';
import type { DomainEvent } from '../../core/domain-events.service.js';

/**
 * Double-entry ledger ports (wave P2a). Journal entries are immutable: the
 * port exposes no update/remove for entries — corrections are new entries
 * with `reversesEntryId` set. Accounts are keyed by their unique natural
 * `code` (e.g. platform:cash, member:<userId>:loan_receivable).
 */
export interface LedgerAccountRepository {
  findByCode(code: string): Promise<LedgerAccount | undefined>;
  create(account: LedgerAccount): Promise<LedgerAccount>;
  all(): Promise<LedgerAccount[]>;
}

export interface LedgerEntryCriteria {
  referenceType?: string;
  referenceId?: string;
}

export interface LedgerEntryRepository {
  /**
   * True when postEntry persists a passed outbox event in the same database
   * transaction as the journal entry (PostgreSQL implementation).
   */
  readonly transactionalOutbox?: boolean;
  findById(id: string): Promise<LedgerJournalEntry | undefined>;
  findByIdempotencyKey(key: string): Promise<LedgerJournalEntry | undefined>;
  /** The reversal entry pointing at `entryId`, if one was posted. */
  findReversalOf(entryId: string): Promise<LedgerJournalEntry | undefined>;
  find(criteria: LedgerEntryCriteria): Promise<LedgerJournalEntry[]>;
  /**
   * Persists a validated, balanced journal entry as one atomic unit: the
   * transfer row plus its ≥2 posting rows commit or roll back together.
   *
   * `requireSolventAccounts` (funds-integrity wave): account codes whose
   * post-entry balance must stay non-negative; the check runs inside the
   * same transaction, so an underfunded posting rolls back atomically.
   * `outboxEvent` is appended to events.outbox in the same transaction when
   * the implementation sets `transactionalOutbox` (ignored otherwise).
   */
  postEntry(
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent
  ): Promise<LedgerJournalEntry>;
  entriesForAccount(accountCode: string): Promise<LedgerJournalEntry[]>;
  /** Aggregated debit/credit totals (integer kobo) for an account. */
  balance(accountCode: string): Promise<LedgerBalance>;
}

export class InMemoryLedgerAccountRepository implements LedgerAccountRepository {
  private readonly items = new Map<string, LedgerAccount>();

  constructor(seed: readonly LedgerAccount[] = []) {
    for (const account of seed) {
      this.items.set(account.code, structuredClone(account));
    }
  }

  async findByCode(code: string): Promise<LedgerAccount | undefined> {
    return this.items.get(code);
  }

  async create(account: LedgerAccount): Promise<LedgerAccount> {
    this.items.set(account.code, account);
    return account;
  }

  async all(): Promise<LedgerAccount[]> {
    return [...this.items.values()];
  }
}

export class InMemoryLedgerEntryRepository implements LedgerEntryRepository {
  private readonly items = new Map<string, LedgerJournalEntry>();

  async findById(id: string): Promise<LedgerJournalEntry | undefined> {
    return this.items.get(id);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerJournalEntry | undefined> {
    return [...this.items.values()].find((entry) => entry.idempotencyKey === key);
  }

  async findReversalOf(entryId: string): Promise<LedgerJournalEntry | undefined> {
    return [...this.items.values()].find((entry) => entry.reversesEntryId === entryId);
  }

  async find(criteria: LedgerEntryCriteria): Promise<LedgerJournalEntry[]> {
    return [...this.items.values()].filter(
      (entry) =>
        (!criteria.referenceType || entry.referenceType === criteria.referenceType) &&
        (!criteria.referenceId || entry.referenceId === criteria.referenceId)
    );
  }

  async postEntry(
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[]
  ): Promise<LedgerJournalEntry> {
    this.items.set(entry.id, structuredClone(entry));
    // Solvency guard with rollback semantics: compute the post-entry balance
    // synchronously and back the entry out when a protected account would
    // go negative (mirrors the in-transaction check of the pg posting).
    for (const accountCode of requireSolventAccounts ?? []) {
      const { balanceKobo } = await this.balance(accountCode);
      if (balanceKobo < 0) {
        this.items.delete(entry.id);
        throw new BadRequestException(
          `Insufficient funds: posting would take ledger account '${accountCode}' negative (${balanceKobo} kobo)`
        );
      }
    }
    return entry;
  }

  async entriesForAccount(accountCode: string): Promise<LedgerJournalEntry[]> {
    return [...this.items.values()].filter((entry) =>
      entry.postings.some((posting) => posting.accountCode === accountCode)
    );
  }

  async balance(accountCode: string): Promise<LedgerBalance> {
    let debitsKobo = 0;
    let creditsKobo = 0;
    for (const entry of this.items.values()) {
      for (const posting of entry.postings) {
        if (posting.accountCode !== accountCode) continue;
        if (posting.direction === 'debit') {
          debitsKobo += posting.amountKobo;
        } else {
          creditsKobo += posting.amountKobo;
        }
      }
    }
    return { accountCode, debitsKobo, creditsKobo, balanceKobo: debitsKobo - creditsKobo };
  }
}

export const PLATFORM_LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  {
    id: 'ledger-account-platform-cash',
    code: 'platform:cash',
    type: 'asset' as LedgerAccountType,
    currency: 'NGN',
    createdAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'ledger-account-platform-interest-income',
    code: 'platform:interest_income',
    type: 'revenue' as LedgerAccountType,
    currency: 'NGN',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
];

export function createInMemoryLedgerAccountRepository(): InMemoryLedgerAccountRepository {
  return new InMemoryLedgerAccountRepository(PLATFORM_LEDGER_ACCOUNTS);
}

export function createInMemoryLedgerEntryRepository(): InMemoryLedgerEntryRepository {
  return new InMemoryLedgerEntryRepository();
}
