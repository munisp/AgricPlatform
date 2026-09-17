import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  LedgerAccount,
  LedgerAccountType,
  LedgerBalance,
  LedgerJournalEntry,
  LedgerPosting
} from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  LEDGER_ACCOUNT_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  DailyLimitReservation,
  LedgerAccountRepository,
  LedgerEntryCriteria,
  LedgerEntryRepository,
  LedgerPostingTx
} from '../../database/repositories/ledger.repository.js';
import type { DomainEvent } from '../../core/domain-events.service.js';

export interface PostEntryInput {
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  postings: LedgerPosting[];
  /** Set internally when this entry reverses an earlier one. */
  reversesEntryId?: string;
  /**
   * Solvency guard: these account codes must keep a non-negative balance
   * after the entry posts; the check runs inside the posting transaction so
   * an underfunded posting is rejected atomically (funds-integrity wave).
   */
  requireSolventAccounts?: readonly string[];
  /**
   * Atomic daily cash-limit reservation (stage 27 WP-G2, audit A1-7): the
   * per-(agent, business date) counter is incremented inside the posting
   * transaction only while the cap holds; a breached cap or a failed
   * posting rolls counter and money movement back together.
   */
  dailyLimitReservation?: DailyLimitReservation;
}

/**
 * Result of postEntryInTx (WP-G1 caller-owned transaction fold). When the
 * posting ran inside a caller-owned pg transaction, `event` was appended to
 * the transactional outbox in that transaction and the caller MUST hand the
 * result to `finalizePostedEntry` after its commit (emit + audit). On the
 * non-transactional path `event` is undefined — postEntry already persisted
 * and audited. `replayed` is true when the idempotency key already existed.
 */
export interface PreparedLedgerPost {
  entry: LedgerJournalEntry;
  event?: DomainEvent;
  replayed: boolean;
}

/**
 * Double-entry ledger runtime (wave P2a). Invariants enforced here before
 * persistence (and CHECK-able in SQL via finance.transfer_is_balanced):
 *   - every journal entry has ≥ 2 postings
 *   - SUM(debits) === SUM(credits) in integer kobo (no floats anywhere)
 *   - every amount is a positive safe-integer kobo value
 *   - every posting references an existing account
 * Entries are immutable: corrections post a counter-entry via reverseEntry.
 * Ledger entity ids are plain UUIDs (the pg ledger tables use uuid PKs).
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly events: DomainEventsService,
    @Inject(LEDGER_ACCOUNT_REPOSITORY) private readonly accounts: LedgerAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly entries: LedgerEntryRepository,
    @Optional() private readonly audit?: AuditService
  ) {}

  async listAccounts(): Promise<LedgerAccount[]> {
    return this.accounts.all();
  }

  async getAccountByCode(code: string): Promise<LedgerAccount> {
    const account = await this.accounts.findByCode(code);
    if (!account) {
      throw new NotFoundException(`Ledger account '${code}' not found`);
    }
    return account;
  }

  async createAccount(input: {
    code: string;
    type: LedgerAccountType;
    ownerId?: string;
  }): Promise<LedgerAccount> {
    const existing = await this.accounts.findByCode(input.code);
    if (existing) {
      throw new ConflictException(`Ledger account '${input.code}' already exists`);
    }
    const account: LedgerAccount = {
      id: randomUUID(),
      code: input.code,
      ownerId: input.ownerId,
      type: input.type,
      currency: 'NGN',
      createdAt: new Date().toISOString()
    };
    return this.accounts.create(account);
  }

  /** Idempotent account provisioning used by loan/escrow posting paths. */
  async ensureAccount(input: {
    code: string;
    type: LedgerAccountType;
    ownerId?: string;
  }): Promise<LedgerAccount> {
    const existing = await this.accounts.findByCode(input.code);
    if (existing) {
      return existing;
    }
    try {
      return await this.createAccount(input);
    } catch (error) {
      // Adopt-on-conflict: a concurrent provisioner claimed the code between
      // the check and the create — converge on the winner's account.
      if (error instanceof ConflictException) {
        const winner = await this.accounts.findByCode(input.code);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  async postEntry(input: PostEntryInput, actorId: string): Promise<LedgerJournalEntry> {
    const existing = await this.entries.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing; // idempotent replay of a posting retry
    }
    this.assertBalanced(input.postings);
    for (const posting of input.postings) {
      await this.getAccountByCode(posting.accountCode);
    }
    const entry: LedgerJournalEntry = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      reversesEntryId: input.reversesEntryId,
      postedAt: new Date().toISOString(),
      postings: input.postings
    };
    // On PostgreSQL the journal entry and the outbox event commit in one
    // transaction (transactionalOutbox); in-memory repos persist the event
    // right after the synchronous posting.
    const event = this.events.build(
      'finance.ledger.entry_posted',
      { entryId: entry.id, idempotencyKey: entry.idempotencyKey, referenceId: entry.referenceId },
      actorId
    );
    let posted: LedgerJournalEntry;
    try {
      posted = await this.entries.postEntry(
        entry,
        input.requireSolventAccounts,
        event,
        input.dailyLimitReservation
      );
    } catch (error) {
      // Adopt-on-conflict: the persistence layer enforces UNIQUE on
      // idempotency_key (pg 23505 → 409; in-memory mirror), so a concurrent
      // posting with the same deterministic key loses here — converge on the
      // winner's entry exactly like the replay branch above.
      if (error instanceof ConflictException) {
        const winner = await this.entries.findByIdempotencyKey(input.idempotencyKey);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
    if (this.entries.transactionalOutbox) {
      this.events.emit(event);
    } else {
      await this.events.persist(event);
    }
    await this.audit?.record({
      actorId,
      action: 'finance.ledger.entry_posted',
      entityType: 'ledger_journal_entry',
      entityId: posted.id,
      metadata: {
        idempotencyKey: posted.idempotencyKey,
        referenceType: posted.referenceType,
        referenceId: posted.referenceId,
        postings: posted.postings
      }
    });
    return posted;
  }

  /**
   * Posts inside a CALLER-OWNED transaction (WP-G1 VSLA money-path fold):
   * with a `tx` handle (pg), the transfer + posting rows + solvency guard +
   * outbox event run on the caller's transaction — they commit or roll back
   * TOGETHER with the caller's own state change, and the caller finalizes
   * side effects via `finalizePostedEntry` AFTER its commit. Without a `tx`
   * handle (in-memory) this delegates to the standard postEntry path, which
   * persists/audits inline and returns `event: undefined`. Idempotent:
   * an existing key replays with `replayed: true` and no new event.
   */
  async postEntryInTx(
    tx: LedgerPostingTx | undefined,
    input: PostEntryInput,
    actorId: string
  ): Promise<PreparedLedgerPost> {
    if (!tx) {
      // In-memory: no caller transaction exists; the standard path is the
      // atomic unit and handles outbox persist + audit itself.
      const existing = await this.entries.findByIdempotencyKey(input.idempotencyKey);
      const entry = await this.postEntry(input, actorId);
      return { entry, replayed: existing !== undefined };
    }
    if (!this.entries.postEntryInTx) {
      // Fail closed: a caller-owned pg transaction requires a ledger repo
      // that can post on it — never silently fall back to autocommit here.
      throw new ServiceUnavailableException(
        'Ledger repository does not support caller-owned transaction postings'
      );
    }
    const existing = await this.entries.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { entry: existing, replayed: true };
    }
    this.assertBalanced(input.postings);
    for (const posting of input.postings) {
      await this.getAccountByCode(posting.accountCode);
    }
    const entry: LedgerJournalEntry = {
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      description: input.description,
      reversesEntryId: input.reversesEntryId,
      postedAt: new Date().toISOString(),
      postings: input.postings
    };
    const event = this.events.build(
      'finance.ledger.entry_posted',
      { entryId: entry.id, idempotencyKey: entry.idempotencyKey, referenceId: entry.referenceId },
      actorId
    );
    await this.entries.postEntryInTx(tx, entry, input.requireSolventAccounts, event);
    return { entry, event, replayed: false };
  }

  /**
   * Post-commit side effects for a caller-transactional postEntryInTx
   * (WP-G1): emit the outbox event (persisted with the caller's commit) and
   * record the audit row. No-op for replayed or inline-persisted results.
   */
  async finalizePostedEntry(prepared: PreparedLedgerPost, actorId: string): Promise<void> {
    if (!prepared.event) {
      return;
    }
    this.events.emit(prepared.event);
    await this.audit?.record({
      actorId,
      action: 'finance.ledger.entry_posted',
      entityType: 'ledger_journal_entry',
      entityId: prepared.entry.id,
      metadata: {
        idempotencyKey: prepared.entry.idempotencyKey,
        referenceType: prepared.entry.referenceType,
        referenceId: prepared.entry.referenceId,
        postings: prepared.entry.postings
      }
    });
  }

  /**
   * Reverses an entry with a balanced counter-entry (flipped directions).
   * The original stays untouched; an entry can be reversed exactly once and
   * reversals cannot themselves be reversed.
   */
  async reverseEntry(entryId: string, actorId: string): Promise<LedgerJournalEntry> {
    const original = await this.entries.findById(entryId);
    if (!original) {
      throw new NotFoundException(`Ledger journal entry '${entryId}' not found`);
    }
    if (original.reversesEntryId) {
      throw new BadRequestException('Reversal entries cannot themselves be reversed');
    }
    const existingReversal = await this.entries.findReversalOf(entryId);
    if (existingReversal) {
      return existingReversal; // idempotent replay
    }
    return this.postEntry(
      {
        idempotencyKey: `reversal:${original.id}`,
        referenceType: original.referenceType,
        referenceId: original.referenceId,
        description: `Reversal of ${original.id}`,
        reversesEntryId: original.id,
        postings: original.postings.map((posting) => ({
          accountCode: posting.accountCode,
          direction: posting.direction === 'debit' ? 'credit' : 'debit',
          amountKobo: posting.amountKobo
        }))
      },
      actorId
    );
  }

  async getEntry(id: string): Promise<LedgerJournalEntry> {
    const entry = await this.entries.findById(id);
    if (!entry) {
      throw new NotFoundException(`Ledger journal entry '${id}' not found`);
    }
    return entry;
  }

  /**
   * Lookup by idempotency key WITHOUT throwing (stage 24, audit A4-1/A1-3):
   * crash-safe rollback legs must be able to PROVE whether a posting
   * committed under an operation's key before deciding to re-open a claim.
   */
  async findEntryByIdempotencyKey(key: string): Promise<LedgerJournalEntry | undefined> {
    return this.entries.findByIdempotencyKey(key);
  }

  async listEntries(criteria: LedgerEntryCriteria): Promise<LedgerJournalEntry[]> {
    return this.entries.find(criteria);
  }

  async entriesForAccount(accountCode: string): Promise<LedgerJournalEntry[]> {
    await this.getAccountByCode(accountCode);
    return this.entries.entriesForAccount(accountCode);
  }

  async balance(accountCode: string): Promise<LedgerBalance> {
    await this.getAccountByCode(accountCode);
    return this.entries.balance(accountCode);
  }

  /** Balance invariant: ≥2 postings, positive integer kobo, debits === credits. */
  private assertBalanced(postings: LedgerPosting[]): void {
    if (!Array.isArray(postings) || postings.length < 2) {
      throw new BadRequestException('A journal entry requires at least two postings');
    }
    let debits = 0;
    let credits = 0;
    for (const posting of postings) {
      if (!Number.isSafeInteger(posting.amountKobo) || posting.amountKobo <= 0) {
        throw new BadRequestException('Posting amounts must be positive integer kobo');
      }
      if (posting.direction === 'debit') {
        debits += posting.amountKobo;
      } else if (posting.direction === 'credit') {
        credits += posting.amountKobo;
      } else {
        throw new BadRequestException(`Unknown posting direction '${posting.direction}'`);
      }
    }
    if (debits !== credits) {
      throw new BadRequestException(
        `Unbalanced journal entry: debits ${debits} kobo != credits ${credits} kobo`
      );
    }
  }
}
