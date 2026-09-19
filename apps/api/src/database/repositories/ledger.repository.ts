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

/**
 * W2-C2 (V-08): reversal counterpart of DailyLimitReservation — releases
 * `amountKobo` from the (agent, businessDate) counter of the REVERSED
 * transaction's original business date, in the same posting transaction, so
 * the daily cap reflects the reversal (GREATEST-floored at 0; a missing
 * counter row is a no-op).
 */
export interface DailyLimitCorrection {
  agentId: string;
  businessDate: string;
  amountKobo: number;
}

/**
 * Opaque caller-owned transaction handle for in-transaction postings
 * (WP-G1 VSLA fold). Mirrors the input-vouchers `AllocationTx` doctrine:
 * the pg implementation passes the open transaction's client so a caller
 * can commit a ledger posting TOGETHER with its own state change; the
 * in-memory implementation has no handle (each awaited step is already
 * atomic) and callers pass `undefined`.
 */
export interface LedgerPostingTx {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
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
   * WP-G13 (Stage 27, ledger hardening): implementations MUST re-assert the
   * balance invariant at persistence time (Σ debits === Σ credits over ≥2
   * postings), independent of the caller-side validation — the pg
   * implementation checks finance.transfer_is_balanced() INSIDE the posting
   * transaction so an unbalanced posting rolls back atomically; the
   * in-memory implementation validates synchronously before storing.
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
    dailyLimitReservation?: DailyLimitReservation,
    dailyLimitCorrection?: DailyLimitCorrection
  ): Promise<LedgerJournalEntry>;
  /**
   * Optional (pg): the posting body of `postEntry` running on a CALLER-OWNED
   * transaction client — no BEGIN/COMMIT of its own (WP-G1 VSLA fold: the
   * repayment claim, this posting and the repayment row commit or roll back
   * as one unit). Same solvency-guard and outbox semantics as `postEntry`.
   */
  postEntryInTx?(
    tx: LedgerPostingTx,
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent
  ): Promise<LedgerJournalEntry>;
  entriesForAccount(accountCode: string): Promise<LedgerJournalEntry[]>;
  /** Aggregated debit/credit totals (integer kobo) for an account. */
  balance(accountCode: string): Promise<LedgerBalance>;
  /**
   * Reconciliation primitive (WP-G13): committed journal entries whose
   * postings fail the balance invariant (Σ debits !== Σ credits, or fewer
   * than two postings). Always empty when every writer goes through
   * postEntry — a non-empty result proves a writer bypassed the guarded
   * posting path (direct SQL, corruption) and is a drift alert.
   */
  findUnbalancedEntries(): Promise<LedgerJournalEntry[]>;
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

  /**
   * Compensation hook for the OB-12 atomic register-with-accounts write —
   * removes an account by natural key so a failed composed write leaves no
   * orphaned accounts. Not part of the LedgerAccountRepository port (the
   * ledger itself never deletes accounts).
   */
  async remove(code: string): Promise<boolean> {
    return this.items.delete(code);
  }

  async all(): Promise<LedgerAccount[]> {
    return [...this.items.values()];
  }
}

/**
 * WP-G13 balance invariant, shared by the in-memory posting path and the
 * drift detector: ≥2 postings, positive integer kobo amounts, known
 * directions, Σ debits === Σ credits. Mirrors the SQL-side
 * finance.transfer_is_balanced() (001_init.sql) plus its posting count.
 */
export function assertBalancedEntry(entry: LedgerJournalEntry): void {
  const totals = entryBalanceTotals(entry);
  if (totals.postingCount < 2) {
    throw new BadRequestException(
      `Unbalanced journal entry '${entry.id}': ${totals.postingCount} postings (minimum 2)`
    );
  }
  if (totals.debitsKobo !== totals.creditsKobo) {
    throw new BadRequestException(
      `Unbalanced journal entry '${entry.id}': debits ${totals.debitsKobo} kobo != credits ${totals.creditsKobo} kobo`
    );
  }
}

/** Sums an entry's postings; throws on invalid amounts/directions. */
function entryBalanceTotals(entry: LedgerJournalEntry): {
  postingCount: number;
  debitsKobo: number;
  creditsKobo: number;
} {
  let debitsKobo = 0;
  let creditsKobo = 0;
  for (const posting of entry.postings) {
    if (!Number.isSafeInteger(posting.amountKobo) || posting.amountKobo <= 0) {
      throw new BadRequestException('Posting amounts must be positive integer kobo');
    }
    if (posting.direction === 'debit') {
      debitsKobo += posting.amountKobo;
    } else if (posting.direction === 'credit') {
      creditsKobo += posting.amountKobo;
    } else {
      throw new BadRequestException(`Unknown posting direction '${posting.direction}'`);
    }
  }
  return { postingCount: entry.postings.length, debitsKobo, creditsKobo };
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
    dailyLimitReservation?: DailyLimitReservation,
    dailyLimitCorrection?: DailyLimitCorrection
  ): Promise<LedgerJournalEntry> {
    // WP-G13: the same persistence-level balance assertion the pg posting
    // enforces in-transaction via finance.transfer_is_balanced() — an
    // unbalanced entry is refused BEFORE any state change (fail closed).
    assertBalancedEntry(entry);
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
    // W2-C2 (V-08): reversal releases capacity on the ORIGINAL business date.
    let correctionKey: string | undefined;
    if (dailyLimitCorrection) {
      correctionKey = `${dailyLimitCorrection.agentId}|${dailyLimitCorrection.businessDate}`;
      this.dailyUsage.set(
        correctionKey,
        Math.max(0, (this.dailyUsage.get(correctionKey) ?? 0) - dailyLimitCorrection.amountKobo)
      );
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
        if (correctionKey && dailyLimitCorrection) {
          this.dailyUsage.set(
            correctionKey,
            (this.dailyUsage.get(correctionKey) ?? 0) + dailyLimitCorrection.amountKobo
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

  async findUnbalancedEntries(): Promise<LedgerJournalEntry[]> {
    return [...this.items.values()].filter((entry) => {
      try {
        assertBalancedEntry(entry);
        return false;
      } catch {
        return true;
      }
    });
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
