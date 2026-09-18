import type pg from 'pg';
import { ConflictException } from '@nestjs/common';
import type {
  ApiListResponse,
  ParametricPayout,
  ParametricPayoutStatus,
  ParametricPolicy,
  ParametricPolicyStatus,
  ParametricProduct,
  ParametricTriggerEvent
} from '@agric-platform/shared';
import { pageSlice } from '../../common/pagination.js';
import { composeWhere, eq, mapPgError, ts, type WhereClause } from '../pg/pg-repository.base.js';
import type {
  ParametricPayoutCriteria,
  ParametricPayoutRepository,
  ParametricPolicyCriteria,
  ParametricPolicyRepository,
  ParametricProductCriteria,
  ParametricProductRepository,
  ParametricTriggerEventCriteria,
  ParametricTriggerEventRepository,
  RegenDiscountCriteria,
  RegenDiscountRateCardRecord,
  RegenDiscountRateCardRepository,
  RegenDiscountRecord,
  RegenDiscountRepository,
  VoucherCoverCriteria,
  VoucherCoverRecord,
  VoucherCoverRepository,
  VoucherProgrammeRiderRecord,
  VoucherProgrammeRiderRepository
} from './insurance.repository.js';

/**
 * PostgreSQL repositories for the parametric insurance rail over schema
 * `insurance` (migration 031). Self-contained SQL keeps the wave additive —
 * no edits to the shared row-mappers module.
 */

interface ProductRow {
  id: string;
  code: string;
  name: string;
  description: string;
  peril: ParametricProduct['peril'];
  trigger_definition: ParametricProduct['trigger'];
  payout_table: ParametricProduct['payoutTable'];
  premium_rate_bps: number;
  created_at: string;
}

function productFromRow(row: ProductRow): ParametricProduct {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    peril: row.peril,
    trigger: row.trigger_definition,
    payoutTable: row.payout_table,
    premiumRateBps: Number(row.premium_rate_bps),
    createdAt: ts(row.created_at)
  };
}

export class PgParametricProductRepository implements ParametricProductRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(record: ParametricProduct): Promise<ParametricProduct> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.products
           (id, code, name, description, peril, trigger_definition, payout_table, premium_rate_bps, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (code)
         DO UPDATE SET name = EXCLUDED.name,
                       description = EXCLUDED.description,
                       peril = EXCLUDED.peril,
                       trigger_definition = EXCLUDED.trigger_definition,
                       payout_table = EXCLUDED.payout_table,
                       premium_rate_bps = EXCLUDED.premium_rate_bps`,
        [
          record.id,
          record.code,
          record.name,
          record.description,
          record.peril,
          JSON.stringify(record.trigger),
          JSON.stringify(record.payoutTable),
          record.premiumRateBps,
          record.createdAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async find(criteria: ParametricProductCriteria): Promise<ParametricProduct[]> {
    const where = composeWhere(eq('code', criteria.code), eq('peril', criteria.peril));
    const result = await this.pool.query<ProductRow>(
      `SELECT * FROM insurance.products ${where.where} ORDER BY code`,
      where.params
    );
    return result.rows.map(productFromRow);
  }

  async findOne(criteria: ParametricProductCriteria): Promise<ParametricProduct | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<ParametricProduct | undefined> {
    const result = await this.pool.query<ProductRow>(
      'SELECT * FROM insurance.products WHERE id = $1',
      [id]
    );
    return result.rows[0] ? productFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<ParametricProduct[]> {
    const result = await this.pool.query<ProductRow>(
      'SELECT * FROM insurance.products ORDER BY code'
    );
    return result.rows.map(productFromRow);
  }
}

export function createPgParametricProductRepository(pool: pg.Pool): PgParametricProductRepository {
  return new PgParametricProductRepository(pool);
}

// ---------------------------------------------------------------------------

interface PolicyRow {
  id: string;
  farmer_user_id: string;
  plot_id: string;
  product_id: string;
  product_code: string;
  season: string;
  sum_insured_kobo: string | number;
  premium_kobo: string | number;
  flood_band: ParametricPolicy['floodBand'];
  pricing_basis: ParametricPolicy['pricingBasis'];
  status: ParametricPolicyStatus;
  created_at: string;
  updated_at: string;
}

function policyFromRow(row: PolicyRow): ParametricPolicy {
  return {
    id: row.id,
    farmerUserId: row.farmer_user_id,
    plotId: row.plot_id,
    productId: row.product_id,
    productCode: row.product_code,
    season: row.season,
    sumInsuredKobo: Number(row.sum_insured_kobo),
    premiumKobo: Number(row.premium_kobo),
    floodBand: row.flood_band,
    pricingBasis: row.pricing_basis,
    status: row.status,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgParametricPolicyRepository implements ParametricPolicyRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: ParametricPolicy): Promise<ParametricPolicy> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.policies
           (id, farmer_user_id, plot_id, product_id, product_code, season,
            sum_insured_kobo, premium_kobo, flood_band, pricing_basis, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          record.id,
          record.farmerUserId,
          record.plotId,
          record.productId,
          record.productCode,
          record.season,
          record.sumInsuredKobo,
          record.premiumKobo,
          record.floodBand,
          record.pricingBasis,
          record.status,
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async update(record: ParametricPolicy): Promise<ParametricPolicy> {
    await this.pool.query(
      `UPDATE insurance.policies
         SET status = $2, premium_kobo = $3, flood_band = $4, pricing_basis = $5, updated_at = $6
       WHERE id = $1`,
      [
        record.id,
        record.status,
        record.premiumKobo,
        record.floodBand,
        record.pricingBasis,
        record.updatedAt
      ]
    );
    return record;
  }

  /**
   * Guarded status transition: the UPDATE carries the expected status in its
   * WHERE clause, so a concurrent transition makes the statement affect zero
   * rows and the caller surfaces 409 instead of double-firing.
   */
  async transition(
    id: string,
    expectedStatus: ParametricPolicyStatus,
    patch: Partial<ParametricPolicy>
  ): Promise<ParametricPolicy> {
    const result = await this.pool.query<PolicyRow>(
      `UPDATE insurance.policies
         SET status = $2, updated_at = $3
       WHERE id = $1 AND status = $4
       RETURNING *`,
      [id, patch.status ?? expectedStatus, patch.updatedAt ?? new Date().toISOString(), expectedStatus]
    );
    if (!result.rows[0]) {
      const current = await this.findById(id);
      throw new ConflictException(
        current
          ? `Insurance policy '${id}' is '${current.status}', not '${expectedStatus}'`
          : `Insurance policy '${id}' not found`
      );
    }
    return policyFromRow(result.rows[0]);
  }

  async find(criteria: ParametricPolicyCriteria): Promise<ParametricPolicy[]> {
    const where = this.where(criteria);
    const result = await this.pool.query<PolicyRow>(
      `SELECT * FROM insurance.policies ${where.where} ORDER BY created_at DESC, id`,
      where.params
    );
    return result.rows.map(policyFromRow);
  }

  async findById(id: string): Promise<ParametricPolicy | undefined> {
    const result = await this.pool.query<PolicyRow>(
      'SELECT * FROM insurance.policies WHERE id = $1',
      [id]
    );
    return result.rows[0] ? policyFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<ParametricPolicy[]> {
    const result = await this.pool.query<PolicyRow>(
      'SELECT * FROM insurance.policies ORDER BY created_at DESC, id'
    );
    return result.rows.map(policyFromRow);
  }

  private where(criteria: ParametricPolicyCriteria): WhereClause {
    return composeWhere(
      eq('farmer_user_id', criteria.farmerUserId),
      eq('status', criteria.status),
      eq('season', criteria.season),
      eq('plot_id', criteria.plotId)
    );
  }
}

export function createPgParametricPolicyRepository(pool: pg.Pool): PgParametricPolicyRepository {
  return new PgParametricPolicyRepository(pool);
}

// ---------------------------------------------------------------------------

interface TriggerEventRow {
  id: string;
  policy_id: string;
  product_id: string;
  farmer_user_id: string;
  evidence: ParametricTriggerEvent['evidence'];
  evidence_fingerprint: string;
  payout_percent: number;
  payout_kobo: string | number;
  created_at: string;
}

function triggerEventFromRow(row: TriggerEventRow): ParametricTriggerEvent {
  return {
    id: row.id,
    policyId: row.policy_id,
    productId: row.product_id,
    farmerUserId: row.farmer_user_id,
    evidence: row.evidence,
    evidenceFingerprint: row.evidence_fingerprint,
    payoutPercent: Number(row.payout_percent),
    payoutKobo: Number(row.payout_kobo),
    createdAt: ts(row.created_at)
  };
}

export class PgParametricTriggerEventRepository implements ParametricTriggerEventRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(
    record: ParametricTriggerEvent
  ): Promise<{ record: ParametricTriggerEvent; created: boolean }> {
    try {
      const result = await this.pool.query<TriggerEventRow>(
        `INSERT INTO insurance.trigger_events
           (id, policy_id, product_id, farmer_user_id, evidence, evidence_fingerprint, payout_percent, payout_kobo, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (policy_id, evidence_fingerprint) DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.policyId,
          record.productId,
          record.farmerUserId,
          JSON.stringify(record.evidence),
          record.evidenceFingerprint,
          record.payoutPercent,
          record.payoutKobo,
          record.createdAt
        ]
      );
      if (result.rows[0]) {
        return { record: triggerEventFromRow(result.rows[0]), created: true };
      }
    } catch (error) {
      mapPgError(error);
    }
    const existing = (
      await this.find({ policyId: record.policyId, evidenceFingerprint: record.evidenceFingerprint })
    )[0];
    return { record: existing ?? record, created: false };
  }

  async find(criteria: ParametricTriggerEventCriteria): Promise<ParametricTriggerEvent[]> {
    const where = composeWhere(
      eq('policy_id', criteria.policyId),
      eq('farmer_user_id', criteria.farmerUserId),
      eq('evidence_fingerprint', criteria.evidenceFingerprint)
    );
    const result = await this.pool.query<TriggerEventRow>(
      `SELECT * FROM insurance.trigger_events ${where.where} ORDER BY created_at DESC, id`,
      where.params
    );
    return result.rows.map(triggerEventFromRow);
  }

  async findById(id: string): Promise<ParametricTriggerEvent | undefined> {
    const result = await this.pool.query<TriggerEventRow>(
      'SELECT * FROM insurance.trigger_events WHERE id = $1',
      [id]
    );
    return result.rows[0] ? triggerEventFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<ParametricTriggerEvent[]> {
    const result = await this.pool.query<TriggerEventRow>(
      'SELECT * FROM insurance.trigger_events ORDER BY created_at DESC, id'
    );
    return result.rows.map(triggerEventFromRow);
  }

  /** Bounded admin listing: LIMIT/OFFSET + COUNT in SQL (V-72). */
  async searchPage(
    criteria: ParametricTriggerEventCriteria,
    page = 1,
    pageSize = 20
  ): Promise<ApiListResponse<ParametricTriggerEvent>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const where = composeWhere(
      eq('policy_id', criteria.policyId),
      eq('farmer_user_id', criteria.farmerUserId),
      eq('evidence_fingerprint', criteria.evidenceFingerprint)
    );
    const [data, total] = await Promise.all([
      this.pool.query<TriggerEventRow>(
        `SELECT * FROM insurance.trigger_events ${where.where}
         ORDER BY created_at DESC, id LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, safeSize, (safePage - 1) * safeSize]
      ),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM insurance.trigger_events ${where.where}`,
        where.params
      )
    ]);
    return pageSlice(total.rows[0].n, data.rows.map(triggerEventFromRow), safePage, safeSize);
  }
}

export function createPgParametricTriggerEventRepository(
  pool: pg.Pool
): PgParametricTriggerEventRepository {
  return new PgParametricTriggerEventRepository(pool);
}

// ---------------------------------------------------------------------------

interface PayoutRow {
  id: string;
  policy_id: string;
  trigger_event_id: string | null;
  farmer_user_id: string;
  amount_kobo: string | number;
  status: ParametricPayoutStatus;
  origin: 'parametric' | 'ex_gratia' | null;
  execution: 'stub';
  ledger_proposal_entry_id: string | null;
  ledger_settlement_entry_id: string | null;
  proposed_at: string;
  paid_at: string | null;
  disputed_at: string | null;
  dispute_reason: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  appealed_at: string | null;
  appeal_reason: string | null;
  reevaluated_at: string | null;
  settled_at: string | null;
  settlement_reference: string | null;
  settlement_failure_reason: string | null;
  settlement_attempts: string | number | null;
}

function payoutFromRow(row: PayoutRow): ParametricPayout {
  return {
    id: row.id,
    policyId: row.policy_id,
    triggerEventId: row.trigger_event_id ?? undefined,
    farmerUserId: row.farmer_user_id,
    amountKobo: Number(row.amount_kobo),
    status: row.status,
    origin: row.origin ?? 'parametric',
    execution: row.execution,
    ledgerProposalEntryId: row.ledger_proposal_entry_id ?? undefined,
    ledgerSettlementEntryId: row.ledger_settlement_entry_id ?? undefined,
    proposedAt: ts(row.proposed_at),
    paidAt: row.paid_at === null ? undefined : ts(row.paid_at),
    disputedAt: row.disputed_at === null ? undefined : ts(row.disputed_at),
    disputeReason: row.dispute_reason ?? undefined,
    rejectedAt: row.rejected_at === null ? undefined : ts(row.rejected_at),
    rejectionReason: row.rejection_reason ?? undefined,
    appealedAt: row.appealed_at === null ? undefined : ts(row.appealed_at),
    appealReason: row.appeal_reason ?? undefined,
    reevaluatedAt: row.reevaluated_at === null ? undefined : ts(row.reevaluated_at),
    settledAt: row.settled_at === null ? undefined : ts(row.settled_at),
    settlementReference: row.settlement_reference ?? undefined,
    settlementFailureReason: row.settlement_failure_reason ?? undefined,
    settlementAttempts:
      row.settlement_attempts === null || row.settlement_attempts === undefined
        ? undefined
        : Number(row.settlement_attempts)
  };
}

export class PgParametricPayoutRepository implements ParametricPayoutRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }> {
    try {
      const result = await this.pool.query<PayoutRow>(
        `INSERT INTO insurance.payouts
           (id, policy_id, trigger_event_id, farmer_user_id, amount_kobo, status, origin, execution,
            ledger_proposal_entry_id, ledger_settlement_entry_id, proposed_at, paid_at,
            disputed_at, dispute_reason, rejected_at, rejection_reason, appealed_at, appeal_reason,
            reevaluated_at, settled_at, settlement_reference, settlement_failure_reason,
            settlement_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (trigger_event_id) WHERE trigger_event_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.policyId,
          record.triggerEventId ?? null,
          record.farmerUserId,
          record.amountKobo,
          record.status,
          record.origin ?? 'parametric',
          record.execution,
          record.ledgerProposalEntryId ?? null,
          record.ledgerSettlementEntryId ?? null,
          record.proposedAt,
          record.paidAt ?? null,
          record.disputedAt ?? null,
          record.disputeReason ?? null,
          record.rejectedAt ?? null,
          record.rejectionReason ?? null,
          record.appealedAt ?? null,
          record.appealReason ?? null,
          record.reevaluatedAt ?? null,
          record.settledAt ?? null,
          record.settlementReference ?? null,
          record.settlementFailureReason ?? null,
          record.settlementAttempts ?? 0
        ]
      );
      if (result.rows[0]) {
        return { record: payoutFromRow(result.rows[0]), created: true };
      }
    } catch (error) {
      mapPgError(error);
    }
    const existing = record.triggerEventId
      ? (await this.find({ triggerEventId: record.triggerEventId }))[0]
      : undefined;
    return { record: existing ?? record, created: false };
  }

  async update(record: ParametricPayout): Promise<ParametricPayout> {
    await this.pool.query(
      `UPDATE insurance.payouts
         SET status = $2,
             amount_kobo = $3,
             ledger_proposal_entry_id = $4,
             ledger_settlement_entry_id = $5,
             paid_at = $6,
             disputed_at = $7,
             dispute_reason = $8,
             rejected_at = $9,
             rejection_reason = $10,
             appealed_at = $11,
             appeal_reason = $12,
             reevaluated_at = $13,
             settled_at = $14,
             settlement_reference = $15,
             settlement_failure_reason = $16,
             settlement_attempts = $17
       WHERE id = $1`,
      [
        record.id,
        record.status,
        record.amountKobo,
        record.ledgerProposalEntryId ?? null,
        record.ledgerSettlementEntryId ?? null,
        record.paidAt ?? null,
        record.disputedAt ?? null,
        record.disputeReason ?? null,
        record.rejectedAt ?? null,
        record.rejectionReason ?? null,
        record.appealedAt ?? null,
        record.appealReason ?? null,
        record.reevaluatedAt ?? null,
        record.settledAt ?? null,
        record.settlementReference ?? null,
        record.settlementFailureReason ?? null,
        record.settlementAttempts ?? 0
      ]
    );
    return record;
  }

  async find(criteria: ParametricPayoutCriteria): Promise<ParametricPayout[]> {
    const where = composeWhere(
      eq('policy_id', criteria.policyId),
      eq('farmer_user_id', criteria.farmerUserId),
      eq('status', criteria.status),
      eq('trigger_event_id', criteria.triggerEventId)
    );
    const result = await this.pool.query<PayoutRow>(
      `SELECT * FROM insurance.payouts ${where.where} ORDER BY proposed_at DESC, id`,
      where.params
    );
    return result.rows.map(payoutFromRow);
  }

  async findById(id: string): Promise<ParametricPayout | undefined> {
    const result = await this.pool.query<PayoutRow>(
      'SELECT * FROM insurance.payouts WHERE id = $1',
      [id]
    );
    return result.rows[0] ? payoutFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<ParametricPayout[]> {
    const result = await this.pool.query<PayoutRow>(
      'SELECT * FROM insurance.payouts ORDER BY proposed_at DESC, id'
    );
    return result.rows.map(payoutFromRow);
  }

  /** Bounded admin listing: LIMIT/OFFSET + COUNT in SQL (V-72). */
  async searchPage(
    criteria: ParametricPayoutCriteria,
    page = 1,
    pageSize = 20
  ): Promise<ApiListResponse<ParametricPayout>> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const where = composeWhere(
      eq('policy_id', criteria.policyId),
      eq('farmer_user_id', criteria.farmerUserId),
      eq('status', criteria.status),
      eq('trigger_event_id', criteria.triggerEventId)
    );
    const [data, total] = await Promise.all([
      this.pool.query<PayoutRow>(
        `SELECT * FROM insurance.payouts ${where.where}
         ORDER BY proposed_at DESC, id LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, safeSize, (safePage - 1) * safeSize]
      ),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM insurance.payouts ${where.where}`,
        where.params
      )
    ]);
    return pageSlice(total.rows[0].n, data.rows.map(payoutFromRow), safePage, safeSize);
  }
}

export function createPgParametricPayoutRepository(pool: pg.Pool): PgParametricPayoutRepository {
  return new PgParametricPayoutRepository(pool);
}

// ---------------------------------------------------------------------------
// Stage 27 (Insurance-in-the-Bag, migration 057): voucher-bundled cover.

interface RiderRow {
  id: string;
  programme_id: string;
  product_code: string;
  sum_insured_kobo: number;
  premium_rate_bps: number;
  flood_band: VoucherProgrammeRiderRecord['floodBand'];
  status: VoucherProgrammeRiderRecord['status'];
  created_by: string;
  created_at: string;
  updated_at: string;
}

function riderFromRow(row: RiderRow): VoucherProgrammeRiderRecord {
  return {
    id: row.id,
    programmeId: row.programme_id,
    productCode: row.product_code,
    sumInsuredKobo: Number(row.sum_insured_kobo),
    premiumRateBps: Number(row.premium_rate_bps),
    floodBand: row.flood_band,
    status: row.status,
    createdBy: row.created_by,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgVoucherProgrammeRiderRepository implements VoucherProgrammeRiderRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.programme_riders
           (id, programme_id, product_code, sum_insured_kobo, premium_rate_bps,
            flood_band, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          record.id,
          record.programmeId,
          record.productCode,
          record.sumInsuredKobo,
          record.premiumRateBps,
          record.floodBand,
          record.status,
          record.createdBy,
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async update(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord> {
    const result = await this.pool.query(
      `UPDATE insurance.programme_riders
         SET product_code = $2, sum_insured_kobo = $3, premium_rate_bps = $4,
             flood_band = $5, status = $6, updated_at = $7
       WHERE id = $1`,
      [
        record.id,
        record.productCode,
        record.sumInsuredKobo,
        record.premiumRateBps,
        record.floodBand,
        record.status,
        record.updatedAt
      ]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new ConflictException(`Insurance rider '${record.id}' not found`);
    }
    return record;
  }

  async findById(id: string): Promise<VoucherProgrammeRiderRecord | undefined> {
    const result = await this.pool.query<RiderRow>(
      'SELECT * FROM insurance.programme_riders WHERE id = $1',
      [id]
    );
    return result.rows[0] ? riderFromRow(result.rows[0]) : undefined;
  }

  async findByProgrammeId(programmeId: string): Promise<VoucherProgrammeRiderRecord | undefined> {
    const result = await this.pool.query<RiderRow>(
      'SELECT * FROM insurance.programme_riders WHERE programme_id = $1',
      [programmeId]
    );
    return result.rows[0] ? riderFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<VoucherProgrammeRiderRecord[]> {
    const result = await this.pool.query<RiderRow>(
      'SELECT * FROM insurance.programme_riders ORDER BY created_at, id'
    );
    return result.rows.map(riderFromRow);
  }
}

export function createPgVoucherProgrammeRiderRepository(pool: pg.Pool): PgVoucherProgrammeRiderRepository {
  return new PgVoucherProgrammeRiderRepository(pool);
}

// ---------------------------------------------------------------------------

interface VoucherCoverRow {
  id: string;
  voucher_id: string;
  policy_id: string;
  programme_id: string;
  plot_id: string;
  farmer_id: string;
  premium_kobo: number;
  cover_basis: VoucherCoverRecord['coverBasis'];
  status: VoucherCoverRecord['status'];
  created_at: string;
  updated_at: string;
}

function voucherCoverFromRow(row: VoucherCoverRow): VoucherCoverRecord {
  return {
    id: row.id,
    voucherId: row.voucher_id,
    policyId: row.policy_id,
    programmeId: row.programme_id,
    plotId: row.plot_id,
    farmerId: row.farmer_id,
    premiumKobo: Number(row.premium_kobo),
    coverBasis: row.cover_basis,
    status: row.status,
    createdAt: ts(row.created_at),
    updatedAt: ts(row.updated_at)
  };
}

export class PgVoucherCoverRepository implements VoucherCoverRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VoucherCoverRecord): Promise<VoucherCoverRecord> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.voucher_covers
           (id, voucher_id, policy_id, programme_id, plot_id, farmer_id,
            premium_kobo, cover_basis, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          record.voucherId,
          record.policyId,
          record.programmeId,
          record.plotId,
          record.farmerId,
          record.premiumKobo,
          record.coverBasis,
          record.status,
          record.createdAt,
          record.updatedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  /**
   * Guarded compare-and-set: the expected status rides in the WHERE clause,
   * so a concurrent projection affects zero rows and surfaces 409 instead of
   * double-firing a transition (same doctrine as the policy CAS above).
   */
  async updateExpected(
    id: string,
    patch: Partial<VoucherCoverRecord>,
    expected: Partial<VoucherCoverRecord>
  ): Promise<VoucherCoverRecord> {
    const columns: Record<string, string> = { status: 'status', updatedAt: 'updated_at' };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        params.push(patch[key as keyof VoucherCoverRecord]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const where: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in expected) {
        params.push(expected[key as keyof VoucherCoverRecord]);
        where.push(`${column} = $${params.length}`);
      }
    }
    const result = await this.pool.query<VoucherCoverRow>(
      `UPDATE insurance.voucher_covers SET ${sets.join(', ')} WHERE id = $1` +
        (where.length > 0 ? ` AND ${where.join(' AND ')}` : '') +
        ' RETURNING *',
      params
    );
    if (!result.rows[0]) {
      throw new ConflictException(`Voucher cover '${id}' changed concurrently; reload and retry`);
    }
    return voucherCoverFromRow(result.rows[0]);
  }

  async findById(id: string): Promise<VoucherCoverRecord | undefined> {
    const result = await this.pool.query<VoucherCoverRow>(
      'SELECT * FROM insurance.voucher_covers WHERE id = $1',
      [id]
    );
    return result.rows[0] ? voucherCoverFromRow(result.rows[0]) : undefined;
  }

  async findByVoucherId(voucherId: string): Promise<VoucherCoverRecord | undefined> {
    const result = await this.pool.query<VoucherCoverRow>(
      'SELECT * FROM insurance.voucher_covers WHERE voucher_id = $1',
      [voucherId]
    );
    return result.rows[0] ? voucherCoverFromRow(result.rows[0]) : undefined;
  }

  async find(criteria: VoucherCoverCriteria): Promise<VoucherCoverRecord[]> {
    const where = composeWhere(
      eq('voucher_id', criteria.voucherId),
      eq('policy_id', criteria.policyId),
      eq('programme_id', criteria.programmeId),
      eq('farmer_id', criteria.farmerId),
      eq('status', criteria.status)
    );
    const result = await this.pool.query<VoucherCoverRow>(
      `SELECT * FROM insurance.voucher_covers ${where.where} ORDER BY created_at, id`,
      where.params
    );
    return result.rows.map(voucherCoverFromRow);
  }

  async all(): Promise<VoucherCoverRecord[]> {
    const result = await this.pool.query<VoucherCoverRow>(
      'SELECT * FROM insurance.voucher_covers ORDER BY created_at, id'
    );
    return result.rows.map(voucherCoverFromRow);
  }
}

export function createPgVoucherCoverRepository(pool: pg.Pool): PgVoucherCoverRepository {
  return new PgVoucherCoverRepository(pool);
}

// ---------------------------------------------------------------------------
// Stage 27 (Regen Discount, migration 070): versioned discount rate card +
// one-discount-per-policy records.

interface RegenRateCardRow {
  version: number;
  discount_bps: number;
  set_by: string;
  created_at: string;
}

function regenRateCardFromRow(row: RegenRateCardRow): RegenDiscountRateCardRecord {
  return {
    version: Number(row.version),
    discountBps: Number(row.discount_bps),
    setBy: row.set_by,
    createdAt: ts(row.created_at)
  };
}

export class PgRegenDiscountRateCardRepository implements RegenDiscountRateCardRepository {
  constructor(private readonly pool: pg.Pool) {}

  async append(record: RegenDiscountRateCardRecord): Promise<RegenDiscountRateCardRecord> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.regen_discount_rate_card (version, discount_bps, set_by, created_at)
         VALUES ($1, $2, $3, $4)`,
        [record.version, record.discountBps, record.setBy, record.createdAt]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async current(): Promise<RegenDiscountRateCardRecord | undefined> {
    const result = await this.pool.query<RegenRateCardRow>(
      'SELECT * FROM insurance.regen_discount_rate_card ORDER BY version DESC LIMIT 1'
    );
    return result.rows[0] ? regenRateCardFromRow(result.rows[0]) : undefined;
  }

  async all(): Promise<RegenDiscountRateCardRecord[]> {
    const result = await this.pool.query<RegenRateCardRow>(
      'SELECT * FROM insurance.regen_discount_rate_card ORDER BY version'
    );
    return result.rows.map(regenRateCardFromRow);
  }
}

export function createPgRegenDiscountRateCardRepository(pool: pg.Pool): PgRegenDiscountRateCardRepository {
  return new PgRegenDiscountRateCardRepository(pool);
}

// ---------------------------------------------------------------------------

interface RegenDiscountRow {
  id: string;
  policy_id: string;
  plot_id: string;
  attestation_id: string;
  discount_bps: number;
  discount_kobo: number;
  rate_card_version: number;
  evidence_basis: RegenDiscountRecord['evidenceBasis'];
  applied_at: string;
}

function regenDiscountFromRow(row: RegenDiscountRow): RegenDiscountRecord {
  return {
    id: row.id,
    policyId: row.policy_id,
    plotId: row.plot_id,
    attestationId: row.attestation_id,
    discountBps: Number(row.discount_bps),
    discountKobo: Number(row.discount_kobo),
    rateCardVersion: Number(row.rate_card_version),
    evidenceBasis: row.evidence_basis,
    appliedAt: ts(row.applied_at)
  };
}

export class PgRegenDiscountRepository implements RegenDiscountRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: RegenDiscountRecord): Promise<RegenDiscountRecord> {
    try {
      await this.pool.query(
        `INSERT INTO insurance.regen_discounts
           (id, policy_id, plot_id, attestation_id, discount_bps, discount_kobo,
            rate_card_version, evidence_basis, applied_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.policyId,
          record.plotId,
          record.attestationId,
          record.discountBps,
          record.discountKobo,
          record.rateCardVersion,
          record.evidenceBasis,
          record.appliedAt
        ]
      );
    } catch (error) {
      mapPgError(error);
    }
    return record;
  }

  async findByPolicyId(policyId: string): Promise<RegenDiscountRecord | undefined> {
    const result = await this.pool.query<RegenDiscountRow>(
      'SELECT * FROM insurance.regen_discounts WHERE policy_id = $1',
      [policyId]
    );
    return result.rows[0] ? regenDiscountFromRow(result.rows[0]) : undefined;
  }

  async find(criteria: RegenDiscountCriteria): Promise<RegenDiscountRecord[]> {
    const where = composeWhere(
      eq('policy_id', criteria.policyId),
      eq('plot_id', criteria.plotId),
      eq('attestation_id', criteria.attestationId),
      eq('evidence_basis', criteria.evidenceBasis)
    );
    const result = await this.pool.query<RegenDiscountRow>(
      `SELECT * FROM insurance.regen_discounts ${where.where} ORDER BY applied_at, id`,
      where.params
    );
    return result.rows.map(regenDiscountFromRow);
  }

  async all(): Promise<RegenDiscountRecord[]> {
    const result = await this.pool.query<RegenDiscountRow>(
      'SELECT * FROM insurance.regen_discounts ORDER BY applied_at, id'
    );
    return result.rows.map(regenDiscountFromRow);
  }
}

export function createPgRegenDiscountRepository(pool: pg.Pool): PgRegenDiscountRepository {
  return new PgRegenDiscountRepository(pool);
}
