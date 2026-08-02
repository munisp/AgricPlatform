import { BadRequestException } from '@nestjs/common';
import type pg from 'pg';
import type {
  CreditScoreResult,
  LedgerAccount,
  LedgerBalance,
  LedgerJournalEntry,
  LedgerPosting
} from '@agric-platform/shared';
import { mapPgError, num, ts } from '../pg/pg-repository.base.js';
import { creditScoreMapper } from '../pg/row-mappers.js';
import type { CreditScoreRepository } from './credit-score.repository.js';
import type {
  LedgerAccountRepository,
  LedgerEntryCriteria,
  LedgerEntryRepository
} from './ledger.repository.js';

/**
 * Double-entry ledger pg repositories over the 001_init.sql tables
 * (finance.ledger_accounts / ledger_transfers / ledger_entries). Account and
 * transfer ids are uuid columns, so the service generates plain UUIDs for
 * ledger entities (no 'prefix-' ids) and postings carry the account natural
 * key (`code`) which is resolved to account ids inside the posting
 * transaction.
 */
function accountFromRow(row: Record<string, unknown>): LedgerAccount {
  return {
    id: row.id as string,
    code: row.code as string,
    ownerId: (row.owner_id as string) ?? undefined,
    type: row.account_type as LedgerAccount['type'],
    currency: row.currency as LedgerAccount['currency'],
    createdAt: ts(row.created_at)
  };
}

export class PgLedgerAccountRepository implements LedgerAccountRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByCode(code: string): Promise<LedgerAccount | undefined> {
    const result = await this.pool.query(
      `SELECT id, code, owner_id, account_type, currency, created_at
         FROM finance.ledger_accounts WHERE code = $1`,
      [code]
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : undefined;
  }

  async create(account: LedgerAccount): Promise<LedgerAccount> {
    try {
      const result = await this.pool.query(
        `INSERT INTO finance.ledger_accounts (id, code, owner_id, account_type, currency)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, owner_id, account_type, currency, created_at`,
        [account.id, account.code, account.ownerId ?? null, account.type, account.currency]
      );
      return accountFromRow(result.rows[0]);
    } catch (error) {
      mapPgError(error);
    }
  }

  async all(): Promise<LedgerAccount[]> {
    const result = await this.pool.query(
      `SELECT id, code, owner_id, account_type, currency, created_at
         FROM finance.ledger_accounts ORDER BY code`
    );
    return result.rows.map(accountFromRow);
  }
}

interface TransferRow extends Record<string, unknown> {
  id: string;
  idempotency_key: string;
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  reverses_transfer_id: string | null;
  posted_at: unknown;
}

const TRANSFER_SELECT = `SELECT t.id, t.idempotency_key, t.reference_type, t.reference_id,
       t.description, t.reverses_transfer_id, t.posted_at
  FROM finance.ledger_transfers t`;

export class PgLedgerEntryRepository implements LedgerEntryRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async withPostings(rows: TransferRow[]): Promise<LedgerJournalEntry[]> {
    const entries: LedgerJournalEntry[] = [];
    for (const row of rows) {
      const postings = await this.pool.query(
        `SELECT a.code AS account_code, e.direction, e.amount_kobo
           FROM finance.ledger_entries e
           JOIN finance.ledger_accounts a ON a.id = e.account_id
          WHERE e.transfer_id = $1
          ORDER BY e.created_at, e.id`,
        [row.id]
      );
      entries.push({
        id: row.id,
        idempotencyKey: row.idempotency_key,
        referenceType: row.reference_type ?? undefined,
        referenceId: row.reference_id ?? undefined,
        description: row.description ?? undefined,
        reversesEntryId: row.reverses_transfer_id ?? undefined,
        postedAt: ts(row.posted_at),
        postings: postings.rows.map(
          (posting): LedgerPosting => ({
            accountCode: posting.account_code as string,
            direction: posting.direction as LedgerPosting['direction'],
            amountKobo: num(posting.amount_kobo)
          })
        )
      });
    }
    return entries;
  }

  private async findOneWhere(where: string, params: unknown[]): Promise<LedgerJournalEntry | undefined> {
    const result = await this.pool.query(`${TRANSFER_SELECT} WHERE ${where} LIMIT 1`, params);
    const [entry] = await this.withPostings(result.rows as TransferRow[]);
    return entry;
  }

  async findById(id: string): Promise<LedgerJournalEntry | undefined> {
    return this.findOneWhere('t.id = $1', [id]);
  }

  async findByIdempotencyKey(key: string): Promise<LedgerJournalEntry | undefined> {
    return this.findOneWhere('t.idempotency_key = $1', [key]);
  }

  async findReversalOf(entryId: string): Promise<LedgerJournalEntry | undefined> {
    return this.findOneWhere('t.reverses_transfer_id = $1', [entryId]);
  }

  async find(criteria: LedgerEntryCriteria): Promise<LedgerJournalEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (criteria.referenceType) {
      params.push(criteria.referenceType);
      conditions.push(`t.reference_type = $${params.length}`);
    }
    if (criteria.referenceId) {
      params.push(criteria.referenceId);
      conditions.push(`t.reference_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(`${TRANSFER_SELECT}${where} ORDER BY t.posted_at, t.id`, params);
    return this.withPostings(result.rows as TransferRow[]);
  }

  /**
   * Atomic posting (plan §2.3 transaction rule): transfer row plus posting
   * rows commit or roll back together. Account codes are resolved to ids
   * inside the transaction; unknown codes fail the whole posting.
   */
  async postEntry(entry: LedgerJournalEntry): Promise<LedgerJournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO finance.ledger_transfers
             (id, idempotency_key, reference_type, reference_id, description, reverses_transfer_id, posted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            entry.id,
            entry.idempotencyKey,
            entry.referenceType ?? null,
            entry.referenceId ?? null,
            entry.description ?? null,
            entry.reversesEntryId ?? null,
            entry.postedAt
          ]
        );
      } catch (error) {
        mapPgError(error);
      }
      for (const posting of entry.postings) {
        const account = await client.query(
          `SELECT id FROM finance.ledger_accounts WHERE code = $1`,
          [posting.accountCode]
        );
        if (!account.rows[0]) {
          throw new BadRequestException(`Unknown ledger account code '${posting.accountCode}'`);
        }
        await client.query(
          `INSERT INTO finance.ledger_entries (transfer_id, account_id, direction, amount_kobo)
           VALUES ($1, $2, $3, $4)`,
          [entry.id, account.rows[0].id, posting.direction, posting.amountKobo]
        );
      }
      await client.query('COMMIT');
      return entry;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async entriesForAccount(accountCode: string): Promise<LedgerJournalEntry[]> {
    const result = await this.pool.query(
      `${TRANSFER_SELECT}
        WHERE EXISTS (
          SELECT 1 FROM finance.ledger_entries e
          JOIN finance.ledger_accounts a ON a.id = e.account_id
          WHERE e.transfer_id = t.id AND a.code = $1
        )
        ORDER BY t.posted_at, t.id`,
      [accountCode]
    );
    return this.withPostings(result.rows as TransferRow[]);
  }

  async balance(accountCode: string): Promise<LedgerBalance> {
    const result = await this.pool.query(
      `SELECT
         COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0) AS debits,
         COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0) AS credits
       FROM finance.ledger_entries e
       JOIN finance.ledger_accounts a ON a.id = e.account_id
       WHERE a.code = $1`,
      [accountCode]
    );
    const debitsKobo = num(result.rows[0]?.debits ?? 0);
    const creditsKobo = num(result.rows[0]?.credits ?? 0);
    return { accountCode, debitsKobo, creditsKobo, balanceKobo: debitsKobo - creditsKobo };
  }
}

/** Versioned credit scores over finance.credit_scores, keyed by user_id. */
export class PgCreditScoreRepository implements CreditScoreRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByUserId(userId: string): Promise<CreditScoreResult | undefined> {
    const result = await this.pool.query(
      `SELECT ${creditScoreMapper.columns.join(', ')} FROM finance.credit_scores WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] ? creditScoreMapper.fromRow(result.rows[0]) : undefined;
  }

  async upsert(result0: CreditScoreResult): Promise<CreditScoreResult> {
    const row = creditScoreMapper.toRow(result0);
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => column !== 'user_id')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO finance.credit_scores (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (user_id) DO UPDATE SET ${assignments}, updated_at = now()`,
      columns.map((column) => row[column])
    );
    return result0;
  }
}

export function createPgLedgerAccountRepository(pool: pg.Pool): PgLedgerAccountRepository {
  return new PgLedgerAccountRepository(pool);
}

export function createPgLedgerEntryRepository(pool: pg.Pool): PgLedgerEntryRepository {
  return new PgLedgerEntryRepository(pool);
}

export function createPgCreditScoreRepository(pool: pg.Pool): PgCreditScoreRepository {
  return new PgCreditScoreRepository(pool);
}
