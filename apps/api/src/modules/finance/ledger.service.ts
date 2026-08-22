import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional
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
  LedgerAccountRepository,
  LedgerEntryCriteria,
  LedgerEntryRepository
} from '../../database/repositories/ledger.repository.js';

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
    return (await this.accounts.findByCode(input.code)) ?? this.createAccount(input);
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
    const posted = await this.entries.postEntry(entry, input.requireSolventAccounts, event);
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
