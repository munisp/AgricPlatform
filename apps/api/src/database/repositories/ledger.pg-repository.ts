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
import type { DomainEvent } from '../../core/domain-events.service.js';
import type { CreditScoreRepository } from './credit-score.repository.js';
import type {
  DailyLimitCorrection,
  DailyLimitReservation,
  LedgerAccountRepository,
  LedgerEntryCriteria,
  LedgerEntryRepository,
  LedgerPostingTx
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

/**
 * In-transaction balance assertion (Stage 27, WP-G13 ledger hardening):
 * re-checks the double-entry invariant AFTER this transaction's posting rows
 * are inserted, via the same finance.transfer_is_balanced() function the
 * reconciliation sweep uses (001_init.sql), plus the ≥2-postings minimum the
 * function alone cannot express (an empty transfer balances trivially). A
 * violation throws, so the caller's posting transaction ROLLS BACK the
 * transfer row, every posting row and the outbox event atomically.
 *
 * This runs on the caller's transaction client, so every posting path that
 * funnels through postEntry (standalone postings) or the caller-owned
 * transaction bodies of in-flight PRs #67/#72 (postLedgerEntryTx /
 * postEntryInTx — the multi-entry coop-pool settlement and VSLA folds) gets
 * the same enforcement by calling this helper; when those PRs land, the
 * assertion must move INTO the extracted posting body so no path bypasses it.
 */
export async function assertTransferBalancedTx(
  client: Pick<pg.PoolClient, 'query'>,
  transferId: string
): Promise<void> {
  const result = await client.query(
    `SELECT finance.transfer_is_balanced($1) AS balanced,
            (SELECT count(*) FROM finance.ledger_entries WHERE transfer_id = $1) AS posting_count`,
    [transferId]
  );
  const row = result.rows[0] as { balanced?: boolean | null; posting_count?: unknown } | undefined;
  const postingCount = num(row?.posting_count ?? 0);
  if (row?.balanced !== true || postingCount < 2) {
    throw new BadRequestException(
      `Unbalanced journal entry '${transferId}' (${postingCount} postings): ` +
        'Σ debits != Σ credits — the posting transaction rolls back'
    );
  }
}


/**
 * Transaction-body of a journal posting (Stage 27: extracted so the
 * coop-pool settlement can commit its exactly-once marker + the split
 * transfer + member credit postings in ONE database transaction instead of
 * a separate posting transaction). Callers must hold BEGIN/COMMIT; this
 * runs the identical SQL the standalone postEntry path uses: idempotency
 * key UNIQUE insert (23505 → 409 via mapPgError), account-code resolution,
 * solvency guard, and the optional same-transaction outbox append.
 */
export async function postLedgerEntryTx(
  client: pg.PoolClient,
  entry: LedgerJournalEntry,
  requireSolventAccounts?: readonly string[],
  outboxEvent?: DomainEvent,
  dailyLimitReservation?: DailyLimitReservation,
  dailyLimitCorrection?: DailyLimitCorrection
): Promise<void> {
  // Lock the solvency-protected account rows up front (sorted, to keep a
  // single global lock order) so concurrent postings touching them
  // serialise and the balance check below cannot race.
  for (const accountCode of [...(requireSolventAccounts ?? [])].sort()) {
    await client.query(
      `SELECT id FROM finance.ledger_accounts WHERE code = $1 FOR UPDATE`,
      [accountCode]
    );
  }
  // Daily-limit reservation (stage 27 WP-G2, audit A1-7): ONE atomic
  // conditional upsert replaces the old check-then-act sum. Concurrent
  // same-day requests for an agent serialise on the counter row's
  // primary-key lock; the loser re-evaluates the WHERE against the
  // winner's committed value, so the cap can never be exceeded. No row
  // returned means the reservation would breach the cap — the whole
  // posting (transfer + postings + reservation) rolls back. Likewise a
  // posting failure after this point rolls the reservation back with it.
  if (dailyLimitReservation) {
    const reserved = await client.query(
      `INSERT INTO agent_banking.agent_daily_limits (agent_id, business_date, used_amount_kobo)
       SELECT $1, $2::date, $3::bigint
       WHERE $3::bigint <= $4::bigint
       ON CONFLICT (agent_id, business_date) DO UPDATE
         SET used_amount_kobo = agent_daily_limits.used_amount_kobo + EXCLUDED.used_amount_kobo,
             updated_at = now()
         WHERE agent_daily_limits.used_amount_kobo + EXCLUDED.used_amount_kobo <= $4::bigint
       RETURNING used_amount_kobo`,
      [
        dailyLimitReservation.agentId,
        dailyLimitReservation.businessDate,
        dailyLimitReservation.amountKobo,
        dailyLimitReservation.limitKobo
      ]
    );
    if (reserved.rows.length === 0) {
      throw new BadRequestException(
        `Agent daily limit exceeded: ${dailyLimitReservation.amountKobo} kobo would pass the ${dailyLimitReservation.limitKobo} kobo daily limit`
      );
    }
  }
  // W2-C2 (V-08): reversal counterpart — release capacity on the REVERSED
  // transaction's original business date inside the same posting transaction
  // (rolls back with the posting). Floored at 0; a missing counter row is a
  // no-op (e.g. reversing a voucher redemption, which never reserved).
  if (dailyLimitCorrection) {
    await client.query(
      `UPDATE agent_banking.agent_daily_limits
          SET used_amount_kobo = GREATEST(0, used_amount_kobo - $3::bigint), updated_at = now()
        WHERE agent_id = $1 AND business_date = $2`,
      [dailyLimitCorrection.agentId, dailyLimitCorrection.businessDate, dailyLimitCorrection.amountKobo]
    );
  }
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
  // P2 perf: set-based posting — resolve every account code in ONE
  // round-trip and bulk-insert the posting rows with a single
  // INSERT … SELECT, instead of a SELECT+INSERT per posting (N+1). The
  // unknown-code error and the insertion result are identical to the
  // per-row loop: the first unknown code in posting order aborts the
  // transaction before any row is written.
  if (entry.postings.length > 0) {
    const codes = [...new Set(entry.postings.map((posting) => posting.accountCode))];
    const accounts = await client.query(
      `SELECT code, id FROM finance.ledger_accounts WHERE code = ANY($1::text[])`,
      [codes]
    );
    const accountIdByCode = new Map<string, string>(
      accounts.rows.map((row) => [row.code as string, row.id as string])
    );
    for (const posting of entry.postings) {
      if (!accountIdByCode.has(posting.accountCode)) {
        throw new BadRequestException(`Unknown ledger account code '${posting.accountCode}'`);
      }
    }
    await client.query(
      `INSERT INTO finance.ledger_entries (transfer_id, account_id, direction, amount_kobo)
       SELECT $1, resolved.id, posting.direction, posting.amount_kobo
         FROM unnest($2::text[], $3::text[], $4::bigint[])
              AS posting(account_code, direction, amount_kobo)
         JOIN finance.ledger_accounts resolved ON resolved.code = posting.account_code`,
      [
        entry.id,
        entry.postings.map((posting) => posting.accountCode),
        entry.postings.map((posting) => posting.direction),
        entry.postings.map((posting) => posting.amountKobo)
      ]
    );
  }
      // WP-G13: mandatory in-transaction balance assertion — an unbalanced
      // posting can never commit, regardless of which entry point posted it.
      await assertTransferBalancedTx(client, entry.id);
  // Solvency guard (funds-integrity wave): protected accounts must stay
  // non-negative AFTER this entry. The balance is computed inside the
  // posting transaction with the account rows locked (above), so an
  // underfunded disbursement rolls the whole entry back atomically.
  // P2 perf: ONE grouped aggregate for all protected accounts instead of a
  // per-account round-trip. The guard semantics are unchanged: balances are
  // the same SUM over ledger_entries, evaluated inside the posting
  // transaction with the account rows locked above, and the first negative
  // account (in caller order) throws the identical error.
  const solventCodes = [...new Set(requireSolventAccounts ?? [])];
  if (solventCodes.length > 0) {
    const balances = await client.query(
      `SELECT a.code,
             COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0) AS debits,
             COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0) AS credits
       FROM finance.ledger_accounts a
       LEFT JOIN finance.ledger_entries e ON e.account_id = a.id
       WHERE a.code = ANY($1::text[])
       GROUP BY a.code`,
      [solventCodes]
    );
    const totalsByCode = new Map<string, { debits: unknown; credits: unknown }>(
      balances.rows.map((row) => [
        row.code as string,
        { debits: row.debits, credits: row.credits }
      ])
    );
    for (const accountCode of requireSolventAccounts ?? []) {
      const totals = totalsByCode.get(accountCode);
      const balanceKobo = num(totals?.debits ?? 0) - num(totals?.credits ?? 0);
      if (balanceKobo < 0) {
        throw new BadRequestException(
          `Insufficient funds: posting would take ledger account '${accountCode}' negative (${balanceKobo} kobo)`
        );
      }
    }
  }
  if (outboxEvent) {
    await client.query(
      `INSERT INTO events.outbox (id, name, payload, actor_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        outboxEvent.id,
        outboxEvent.name,
        JSON.stringify(outboxEvent.payload ?? {}),
        outboxEvent.actorId ?? null,
        outboxEvent.occurredAt
      ]
    );
  }
}

export class PgLedgerEntryRepository implements LedgerEntryRepository {
  /** postEntry persists a passed outbox event in the posting transaction. */
  readonly transactionalOutbox = true;

  constructor(private readonly pool: pg.Pool) {}

  /**
   * P2 perf: set-based fan-out — one query for the postings of ALL matched
   * transfers (WHERE transfer_id = ANY) grouped in memory, instead of one
   * query per transfer row (N+1). Per-transfer posting order stays
   * (created_at, id), identical to the per-row queries.
   */
  private async withPostings(rows: TransferRow[]): Promise<LedgerJournalEntry[]> {
    const postingsByTransfer = new Map<string, LedgerPosting[]>();
    if (rows.length > 0) {
      const postings = await this.pool.query(
        `SELECT e.transfer_id, a.code AS account_code, e.direction, e.amount_kobo
           FROM finance.ledger_entries e
           JOIN finance.ledger_accounts a ON a.id = e.account_id
          WHERE e.transfer_id = ANY($1::uuid[])
          ORDER BY e.transfer_id, e.created_at, e.id`,
        [rows.map((row) => row.id)]
      );
      for (const posting of postings.rows) {
        const transferId = posting.transfer_id as string;
        const list = postingsByTransfer.get(transferId) ?? [];
        list.push({
          accountCode: posting.account_code as string,
          direction: posting.direction as LedgerPosting['direction'],
          amountKobo: num(posting.amount_kobo)
        });
        postingsByTransfer.set(transferId, list);
      }
    }
    return rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      referenceType: row.reference_type ?? undefined,
      referenceId: row.reference_id ?? undefined,
      description: row.description ?? undefined,
      reversesEntryId: row.reverses_transfer_id ?? undefined,
      postedAt: ts(row.posted_at),
      postings: postingsByTransfer.get(row.id) ?? []
    }));
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
  async postEntry(
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent,
    dailyLimitReservation?: DailyLimitReservation,
    dailyLimitCorrection?: DailyLimitCorrection
  ): Promise<LedgerJournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const posted = await this.postEntryInTx(client, entry, requireSolventAccounts, outboxEvent, dailyLimitReservation, dailyLimitCorrection);
      await client.query('COMMIT');
      return posted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The posting body of `postEntry` on a CALLER-OWNED transaction client
   * (WP-G1 VSLA fold): no BEGIN/COMMIT here — the caller's transaction
   * decides commit/rollback, so a wider logical money movement (e.g. the
   * VSLA repayment claim + this posting + the repayment row) commits or
   * rolls back as ONE unit. Lock order, solvency guard and outbox insert
   * are identical to the standalone path.
   */
  async postEntryInTx(
    tx: LedgerPostingTx,
    entry: LedgerJournalEntry,
    requireSolventAccounts?: readonly string[],
    outboxEvent?: DomainEvent,
    dailyLimitReservation?: DailyLimitReservation,
    dailyLimitCorrection?: DailyLimitCorrection
  ): Promise<LedgerJournalEntry> {
    // Single posting path (merge-resolution doctrine): all in-transaction
    // postings route through postLedgerEntryTx so the solvency guard, the
    // WP-G2 atomic daily-limit reservation, and the same-transaction outbox
    // append apply identically whether the caller owns the transaction
    // (WP-G1 VSLA fold) or this repository opened it (postEntry above).
    await postLedgerEntryTx(
      tx as pg.PoolClient,
      entry,
      requireSolventAccounts,
      outboxEvent,
      dailyLimitReservation,
      dailyLimitCorrection
    );
    return entry;
  }

  /**
   * Reconciliation primitive (WP-G13): committed transfers failing
   * finance.transfer_is_balanced() (or holding fewer than two postings).
   * Always empty when every writer posts through postEntry; a non-empty
   * result proves an unguarded writer (direct SQL/corruption) and is a
   * drift alert.
   */
  async findUnbalancedEntries(): Promise<LedgerJournalEntry[]> {
    // P2 perf: set-based rewrite of the per-row predicate
    // `NOT finance.transfer_is_balanced(t.id) OR (SELECT count(*) …) < 2`.
    // transfer_is_balanced (001_init.sql) is
    // COALESCE(Σ debits,0) = COALESCE(Σ credits,0) — never NULL — so the
    // disjunction is exactly: no posting rows at all (count 0 < 2), fewer
    // than two postings, or debits <> credits. One grouped aggregate pass
    // replaces the per-row PL/pgSQL call + correlated count subquery.
    const result = await this.pool.query(
      `${TRANSFER_SELECT}
        LEFT JOIN (
          SELECT e.transfer_id,
                 count(*) AS posting_count,
                 COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'debit'), 0) AS debits,
                 COALESCE(sum(e.amount_kobo) FILTER (WHERE e.direction = 'credit'), 0) AS credits
            FROM finance.ledger_entries e
           GROUP BY e.transfer_id
        ) s ON s.transfer_id = t.id
        WHERE s.transfer_id IS NULL
           OR s.posting_count < 2
           OR s.debits <> s.credits
        ORDER BY t.posted_at, t.id`
    );
    return this.withPostings(result.rows as TransferRow[]);
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
