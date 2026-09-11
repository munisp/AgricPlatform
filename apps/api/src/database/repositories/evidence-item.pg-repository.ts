import { ConflictException } from '@nestjs/common';
import type pg from 'pg';
import type { EvidenceCaseType, EvidenceItem, EvidenceItemStatus } from '@agric-platform/shared';
import { chainTimestamp } from '../../core/audit-chain.js';
import { EVIDENCE_GENESIS_HASH, linkEvidenceItem } from '../../modules/evidence/evidence-hash.js';
import { ts, type RowMapper } from '../pg/pg-repository.base.js';
import type { EvidenceItemRepository } from './evidence-item.repository.js';

/**
 * PostgreSQL evidence item log over evidence.items (Stage 27 Innovation 13,
 * migration 071) — per-case hash chains with the same fork guard as the
 * audit event chain (migration 043) and anchor chain (migration 047):
 *
 *   * append() extends the case chain through a single guarded
 *     INSERT ... SELECT whose WHERE re-reads the case tip inside the
 *     statement. A racing uploader either fails the tip guard (0 rows) or
 *     collides on UNIQUE (case_type, case_id, prev_hash) (SQLSTATE 23505);
 *     the loser re-reads the new tip and retries up to
 *     EVIDENCE_APPEND_MAX_ATTEMPTS times, then fails loudly.
 *   * UNIQUE (object_key) maps one storage object to exactly one row; a
 *     collision that is NOT a chain race surfaces as ConflictException.
 *   * Append-only: the only UPDATEs are the guarded CAS status transitions
 *     (sealCase / transitionStatus). Status is outside the hashed payload,
 *     so the chain stays verifiable across transitions and tombstones.
 */

/** snake_case row <-> camelCase mapping for evidence.items. */
export const evidenceItemMapper: RowMapper<EvidenceItem> = {
  columns: [
    'id',
    'case_type',
    'case_id',
    'uploader_id',
    'object_key',
    'sha256',
    'prev_hash',
    'item_hash',
    'captured_at',
    'uploaded_at',
    'mime',
    'size_bytes',
    'status'
  ],
  // Every EvidenceItem field is required; captured_at is an explicit null
  // when capture time was not declared (canonicalJSON handles null
  // deterministically — present-but-UNDEFINED keys are what would change
  // the hashed payload). size_bytes is bigint: pg returns it as a string,
  // so it is normalized to a number here or the hash payload would not
  // reproduce the writer's. Timestamps round-trip exactly through ts().
  fromRow: (row) => ({
    id: row.id as string,
    caseType: row.case_type as EvidenceItem['caseType'],
    caseId: row.case_id as string,
    uploaderId: row.uploader_id as string,
    objectKey: row.object_key as string,
    sha256: row.sha256 as string,
    prevHash: row.prev_hash as string,
    itemHash: row.item_hash as string,
    capturedAt: row.captured_at === null ? null : ts(row.captured_at),
    uploadedAt: ts(row.uploaded_at),
    mime: row.mime as string,
    sizeBytes: Number(row.size_bytes),
    status: row.status as EvidenceItem['status']
  }),
  toRow: (item) => ({
    id: item.id,
    case_type: item.caseType,
    case_id: item.caseId,
    uploader_id: item.uploaderId,
    object_key: item.objectKey,
    sha256: item.sha256,
    prev_hash: item.prevHash,
    item_hash: item.itemHash,
    captured_at: item.capturedAt,
    uploaded_at: item.uploadedAt,
    mime: item.mime,
    size_bytes: item.sizeBytes,
    status: item.status
  })
};

const ALL_COLUMNS = evidenceItemMapper.columns.join(', ');

/** Tip ordering for one case chain: uploaded_at with a deterministic id tiebreaker. */
const CASE_TIP_SQL =
  `SELECT ${ALL_COLUMNS} FROM evidence.items ` +
  'WHERE case_type = $1 AND case_id = $2 ORDER BY uploaded_at DESC, id DESC LIMIT 1';

/** Bounded retries for chain-extension races before failing loudly (mirrors 043/047). */
const EVIDENCE_APPEND_MAX_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

/** Jittered backoff between fork-race retries (same reasoning as 047). */
function forkRetryDelayMs(attempt: number): number {
  return 5 * attempt * attempt + Math.floor(Math.random() * 10 * attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PgEvidenceItemRepository implements EvidenceItemRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(unsigned: Omit<EvidenceItem, 'prevHash' | 'itemHash'>): Promise<EvidenceItem> {
    for (let attempt = 1; attempt <= EVIDENCE_APPEND_MAX_ATTEMPTS; attempt += 1) {
      const tip = await this.pool.query(CASE_TIP_SQL, [unsigned.caseType, unsigned.caseId]);
      const tipRow = tip.rows[0] as Record<string, unknown> | undefined;
      const prevHash = (tipRow?.item_hash as string | undefined) ?? EVIDENCE_GENESIS_HASH;
      // pg returns timestamptz as Date; normalize before comparing.
      const tipUploadedAt = tipRow?.uploaded_at ? ts(tipRow.uploaded_at) : undefined;
      // Child item must sort after its parent under (uploaded_at, id) so
      // listCaseItems()/verification walk the chain in link order.
      const uploadedAt = chainTimestamp(tipUploadedAt, unsigned.uploadedAt);
      const linked = linkEvidenceItem({ ...unsigned, uploadedAt }, prevHash);
      const row = evidenceItemMapper.toRow(linked);
      const columns = Object.keys(row);
      // $1..$n = column values, $n+1 = claimed parent hash, $n+2 = genesis,
      // $n+3/$n+4 = case_type/case_id for the tip subquery.
      const claimed = `$${columns.length + 1}`;
      const genesis = `$${columns.length + 2}`;
      const caseTypeParam = `$${columns.length + 3}`;
      const caseIdParam = `$${columns.length + 4}`;
      const tipHashSql =
        'SELECT item_hash FROM evidence.items ' +
        `WHERE case_type = ${caseTypeParam} AND case_id = ${caseIdParam} ` +
        'ORDER BY uploaded_at DESC, id DESC LIMIT 1';
      try {
        const result = await this.pool.query(
          `INSERT INTO evidence.items (${columns.join(', ')})
           SELECT ${columns.map((_, i) => `$${i + 1}`).join(', ')}
           WHERE COALESCE((${tipHashSql}), ${genesis}) = ${claimed}`,
          [
            ...columns.map((column) => row[column]),
            prevHash,
            EVIDENCE_GENESIS_HASH,
            unsigned.caseType,
            unsigned.caseId
          ]
        );
        if (result.rowCount === 1) {
          return linked;
        }
        // Case tip moved between the read and this statement (concurrent upload).
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // UNIQUE(object_key): a retry of an already-recorded object, or a
        // storage-key collision — NOT a chain race. Fail as a conflict.
        const existing = await this.findByObjectKey(unsigned.objectKey);
        if (existing) {
          throw new ConflictException(
            `Evidence object '${unsigned.objectKey}' is already recorded`
          );
        }
        // Otherwise UNIQUE (case_type, case_id, prev_hash) rejected a racing
        // append that committed first — retry against the new tip.
      }
      if (attempt < EVIDENCE_APPEND_MAX_ATTEMPTS) {
        await sleep(forkRetryDelayMs(attempt));
      }
    }
    throw new Error(
      `evidence chain append failed after ${EVIDENCE_APPEND_MAX_ATTEMPTS} attempts — ` +
        'sustained concurrent fork contention on evidence.items'
    );
  }

  async listCaseItems(caseType: EvidenceCaseType, caseId: string): Promise<EvidenceItem[]> {
    const result = await this.pool.query(
      `SELECT ${ALL_COLUMNS} FROM evidence.items
       WHERE case_type = $1 AND case_id = $2 ORDER BY uploaded_at, id`,
      [caseType, caseId]
    );
    return result.rows.map((row) => evidenceItemMapper.fromRow(row));
  }

  async findById(id: string): Promise<EvidenceItem | undefined> {
    const result = await this.pool.query(
      `SELECT ${ALL_COLUMNS} FROM evidence.items WHERE id = $1`,
      [id]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? evidenceItemMapper.fromRow(row) : undefined;
  }

  async findByObjectKey(objectKey: string): Promise<EvidenceItem | undefined> {
    const result = await this.pool.query(
      `SELECT ${ALL_COLUMNS} FROM evidence.items WHERE object_key = $1`,
      [objectKey]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? evidenceItemMapper.fromRow(row) : undefined;
  }

  /** Guarded CAS: active -> sealed for every item of the case, in one statement. */
  async sealCase(caseType: EvidenceCaseType, caseId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE evidence.items SET status = 'sealed'
       WHERE case_type = $1 AND case_id = $2 AND status = 'active'`,
      [caseType, caseId]
    );
    return result.rowCount ?? 0;
  }

  /** Guarded CAS: moves one item from an allowed status to `to` (append-only exception). */
  async transitionStatus(
    id: string,
    from: EvidenceItemStatus[],
    to: EvidenceItemStatus
  ): Promise<EvidenceItem | undefined> {
    const result = await this.pool.query(
      `UPDATE evidence.items SET status = $2 WHERE id = $1 AND status = ANY($3)
       RETURNING ${ALL_COLUMNS}`,
      [id, to, from]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? evidenceItemMapper.fromRow(row) : undefined;
  }

  async listByUploader(uploaderId: string): Promise<EvidenceItem[]> {
    const result = await this.pool.query(
      `SELECT ${ALL_COLUMNS} FROM evidence.items
       WHERE uploader_id = $1 ORDER BY uploaded_at, id`,
      [uploaderId]
    );
    return result.rows.map((row) => evidenceItemMapper.fromRow(row));
  }
}

export function createPgEvidenceItemRepository(pool: pg.Pool): PgEvidenceItemRepository {
  return new PgEvidenceItemRepository(pool);
}
