import type pg from 'pg';
import type { DealerQRPurchase, DealerQRToken } from '@agric-platform/shared';
import type {
  DealerQRRepository,
  DealerTokenCriteria,
  DealerPurchaseCriteria
} from './dealer-qr.repository.js';

/** Postgres unique-violation (duplicate purchase dedupe key, replayed token). */
const PG_UNIQUE_VIOLATION = '23505';

const TOKEN_COLUMNS =
  'id, dealer_id, batch, qr_payload, issued_at, expires_at, redeemed_at, ' +
  'redeemed_farmer_id, redeemed_purchase_id, created_at';

const PURCHASE_COLUMNS =
  'id, dealer_id, token_id, farmer_id, amount_kobo, input_items, dedupe_key, ' +
  'recorded_by, occurred_at, created_at';

/**
 * PostgreSQL implementation over input_vouchers.dealer_qr_tokens and
 * input_vouchers.dealer_qr_purchases (migration 073). Standalone (not
 * PgRepositoryBase): redemption is a guarded token update and purchases
 * carry a dedupe UNIQUE key — neither fits the generic id-keyed base.
 */
export class PgDealerQRRepository implements DealerQRRepository {
  constructor(private readonly pool: pg.Pool) {}

  /* ------------------------------- tokens ------------------------------- */

  async createToken(token: DealerQRToken): Promise<DealerQRToken> {
    await this.pool.query(
      `INSERT INTO input_vouchers.dealer_qr_tokens
         (id, dealer_id, batch, qr_payload, issued_at, expires_at, redeemed_at,
          redeemed_farmer_id, redeemed_purchase_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        token.id,
        token.dealerId,
        token.batch,
        token.qrPayload,
        token.issuedAt,
        token.expiresAt ?? null,
        token.redeemedAt ?? null,
        token.redeemedFarmerId ?? null,
        token.redeemedPurchaseId ?? null,
        token.createdAt
      ]
    );
    return token;
  }

  async getTokenById(id: string): Promise<DealerQRToken | undefined> {
    const result = await this.pool.query(
      `SELECT ${TOKEN_COLUMNS} FROM input_vouchers.dealer_qr_tokens WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.tokenFromRow(result.rows[0]) : undefined;
  }

  async getTokenByPayload(qrPayload: string): Promise<DealerQRToken | undefined> {
    const result = await this.pool.query(
      `SELECT ${TOKEN_COLUMNS} FROM input_vouchers.dealer_qr_tokens WHERE qr_payload = $1`,
      [qrPayload]
    );
    return result.rows[0] ? this.tokenFromRow(result.rows[0]) : undefined;
  }

  async findTokens(criteria: DealerTokenCriteria): Promise<DealerQRToken[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.dealerId) {
      params.push(criteria.dealerId);
      where.push(`dealer_id = $${params.length}`);
    }
    if (criteria.batch) {
      params.push(criteria.batch);
      where.push(`batch = $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${TOKEN_COLUMNS} FROM input_vouchers.dealer_qr_tokens` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY issued_at, id',
      params
    );
    return result.rows.map((row) => this.tokenFromRow(row));
  }

  /**
   * Atomic redemption: flips the token only while unredeemed. Returns the
   * flipped row, or undefined when the token was already redeemed (a
   * concurrent scanner raced us or this is a replay — the service
   * distinguishes by comparing redeemed_purchase_id).
   */
  async markRedeemed(
    id: string,
    patch: { redeemedAt: string; redeemedFarmerId: string; redeemedPurchaseId: string }
  ): Promise<DealerQRToken | undefined> {
    const result = await this.pool.query(
      `UPDATE input_vouchers.dealer_qr_tokens
         SET redeemed_at = $2, redeemed_farmer_id = $3, redeemed_purchase_id = $4
       WHERE id = $1 AND redeemed_at IS NULL
       RETURNING ${TOKEN_COLUMNS}`,
      [id, patch.redeemedAt, patch.redeemedFarmerId, patch.redeemedPurchaseId]
    );
    return result.rows[0] ? this.tokenFromRow(result.rows[0]) : undefined;
  }

  /* ------------------------------ purchases ------------------------------ */

  async createPurchase(purchase: DealerQRPurchase): Promise<DealerQRPurchase> {
    try {
      await this.pool.query(
        `INSERT INTO input_vouchers.dealer_qr_purchases
           (id, dealer_id, token_id, farmer_id, amount_kobo, input_items, dedupe_key,
            recorded_by, occurred_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          purchase.id,
          purchase.dealerId,
          purchase.tokenId,
          purchase.farmerId,
          purchase.amountKobo,
          JSON.stringify(purchase.inputItems),
          purchase.dedupeKey ?? null,
          purchase.recordedBy,
          purchase.occurredAt,
          purchase.createdAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        // Surface the dedupe conflict distinctly so the service can answer
        // the replay with the original row instead of a 500.
        const existing = purchase.dedupeKey
          ? await this.getPurchaseByDedupeKey(purchase.dedupeKey)
          : undefined;
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
    return purchase;
  }

  async getPurchaseById(id: string): Promise<DealerQRPurchase | undefined> {
    const result = await this.pool.query(
      `SELECT ${PURCHASE_COLUMNS} FROM input_vouchers.dealer_qr_purchases WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.purchaseFromRow(result.rows[0]) : undefined;
  }

  async getPurchaseByDedupeKey(dedupeKey: string): Promise<DealerQRPurchase | undefined> {
    const result = await this.pool.query(
      `SELECT ${PURCHASE_COLUMNS} FROM input_vouchers.dealer_qr_purchases WHERE dedupe_key = $1`,
      [dedupeKey]
    );
    return result.rows[0] ? this.purchaseFromRow(result.rows[0]) : undefined;
  }

  async findPurchases(criteria: DealerPurchaseCriteria): Promise<DealerQRPurchase[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (criteria.dealerId) {
      params.push(criteria.dealerId);
      where.push(`dealer_id = $${params.length}`);
    }
    if (criteria.farmerId) {
      params.push(criteria.farmerId);
      where.push(`farmer_id = $${params.length}`);
    }
    if (criteria.tokenId) {
      params.push(criteria.tokenId);
      where.push(`token_id = $${params.length}`);
    }
    const result = await this.pool.query(
      `SELECT ${PURCHASE_COLUMNS} FROM input_vouchers.dealer_qr_purchases` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY occurred_at, id',
      params
    );
    return result.rows.map((row) => this.purchaseFromRow(row));
  }

  async countPurchasesByFarmer(farmerId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT count(*)::int AS n FROM input_vouchers.dealer_qr_purchases WHERE farmer_id = $1',
      [farmerId]
    );
    return result.rows[0].n as number;
  }

  /* -------------------------------- rows -------------------------------- */

  private tokenFromRow(row: Record<string, unknown>): DealerQRToken {
    return {
      id: row.id as string,
      dealerId: row.dealer_id as string,
      batch: row.batch as string,
      qrPayload: row.qr_payload as string,
      issuedAt: new Date(row.issued_at as string).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : undefined,
      redeemedAt: row.redeemed_at ? new Date(row.redeemed_at as string).toISOString() : undefined,
      redeemedFarmerId: (row.redeemed_farmer_id as string | null) ?? undefined,
      redeemedPurchaseId: (row.redeemed_purchase_id as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string).toISOString()
    };
  }

  private purchaseFromRow(row: Record<string, unknown>): DealerQRPurchase {
    return {
      id: row.id as string,
      dealerId: row.dealer_id as string,
      tokenId: row.token_id as string,
      farmerId: row.farmer_id as string,
      amountKobo: Number(row.amount_kobo),
      inputItems: row.input_items as DealerQRPurchase['inputItems'],
      dedupeKey: (row.dedupe_key as string | null) ?? undefined,
      recordedBy: row.recorded_by as string,
      occurredAt: new Date(row.occurred_at as string).toISOString(),
      createdAt: new Date(row.created_at as string).toISOString()
    };
  }
}

export function createPgDealerQRRepository(pool: pg.Pool): PgDealerQRRepository {
  return new PgDealerQRRepository(pool);
}
