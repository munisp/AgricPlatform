import type {
  LedgerAccount,
  LedgerAccountType,
  LedgerBalance,
  LedgerJournalEntry
} from '@agric-platform/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
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

/**
 * Atomic daily cash-limit reservation (stage 27 WP-G2, funds-atomicity
 * audit A1-7). When passed to postEntry, the per-(agent, business date)
 * usage counter is incremented INSIDE the posting transaction, but only
 * while `used + amountKobo <= limitKobo` — otherwise the whole posting is
 * rejected with the standard limit-exceeded error and rolls back. A posting
 * failure after the reservation releases it via the same rollback, so the
 * counter never drifts from committed money movement.
 */
export interface DailyLimitReservation {
  agentId: string;
  /** UTC business date (YYYY-MM-DD); a new date starts a fresh counter. */
  businessDate: string;
  amountKobo: number;
  limitKobo: number;
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
   * `dailyLimitReservation` (stage 27 WP-G2, audit A1-7) atomically reserves
   * against the per-(agent, business date) cash cap in the same transaction;
   * when the cap would be exceeded the posting is rejected and rolls back.
   */
  postEntry(
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent,
    dailyLimitReservation?: DailyLimitReservation
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
  /** Per-(agent, business date) reserved usage, keyed `agentId|businessDate`. */
  private readonly dailyUsage = new Map<string, number>();

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
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent,
    dailyLimitReservation?: DailyLimitReservation
  ): Promise<LedgerJournalEntry> {
    // Mirror the pg UNIQUE constraint on idempotency_key (23505 → 409):
    // concurrent posts with the same key cannot both persist.
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === entry.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    // Daily-limit reservation (stage 27 WP-G2, audit A1-7): the capacity
    // check and the counter increment run synchronously — no await between
    // the read and the write — so concurrent in-memory callers cannot
    // interleave, mirroring the in-transaction conditional upsert of the pg
    // posting (which serialises on the counter row's primary-key lock).
    let reservationKey: string | undefined;
    if (dailyLimitReservation) {
      reservationKey = `${dailyLimitReservation.agentId}|${dailyLimitReservation.businessDate}`;
      const used = this.dailyUsage.get(reservationKey) ?? 0;
      if (used + dailyLimitReservation.amountKobo > dailyLimitReservation.limitKobo) {
        throw new BadRequestException(
          `Agent daily limit exceeded: ${used + dailyLimitReservation.amountKobo} kobo would pass the ${dailyLimitReservation.limitKobo} kobo daily limit`
        );
      }
      this.dailyUsage.set(reservationKey, used + dailyLimitReservation.amountKobo);
    }
    this.items.set(entry.id, structuredClone(entry));
    // Solvency guard with rollback semantics: compute the post-entry balance
    // synchronously and back the entry out when a protected account would
    // go negative (mirrors the in-transaction check of the pg posting).
    for (const accountCode of requireSolventAccounts ?? []) {
      const { balanceKobo } = await this.balance(accountCode);
      if (balanceKobo < 0) {
        this.items.delete(entry.id);
        // Rollback releases the reservation, exactly as the pg transaction
        // rollback does.
        if (reservationKey && dailyLimitReservation) {
          this.dailyUsage.set(
            reservationKey,
            (this.dailyUsage.get(reservationKey) ?? 0) - dailyLimitReservation.amountKobo
          );
        }
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
