import type pg from 'pg';
import { ConflictException } from '@nestjs/common';
import type {
  ParametricPayout,
  ParametricPayoutStatus,
  ParametricPolicy,
  ParametricPolicyStatus,
  ParametricProduct,
  ParametricTriggerEvent
} from '@agric-platform/shared';
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
  RegenDiscountRepository
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
  trigger_event_id: string;
  farmer_user_id: string;
  amount_kobo: string | number;
  status: ParametricPayoutStatus;
  execution: 'stub';
  ledger_proposal_entry_id: string | null;
  ledger_settlement_entry_id: string | null;
  proposed_at: string;
  paid_at: string | null;
}

function payoutFromRow(row: PayoutRow): ParametricPayout {
  return {
    id: row.id,
    policyId: row.policy_id,
    triggerEventId: row.trigger_event_id,
    farmerUserId: row.farmer_user_id,
    amountKobo: Number(row.amount_kobo),
    status: row.status,
    execution: row.execution,
    ledgerProposalEntryId: row.ledger_proposal_entry_id ?? undefined,
    ledgerSettlementEntryId: row.ledger_settlement_entry_id ?? undefined,
    proposedAt: ts(row.proposed_at),
    paidAt: row.paid_at === null ? undefined : ts(row.paid_at)
  };
}

export class PgParametricPayoutRepository implements ParametricPayoutRepository {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }> {
    try {
      const result = await this.pool.query<PayoutRow>(
        `INSERT INTO insurance.payouts
           (id, policy_id, trigger_event_id, farmer_user_id, amount_kobo, status, execution,
            ledger_proposal_entry_id, ledger_settlement_entry_id, proposed_at, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (trigger_event_id) DO NOTHING
         RETURNING *`,
        [
          record.id,
          record.policyId,
          record.triggerEventId,
          record.farmerUserId,
          record.amountKobo,
          record.status,
          record.execution,
          record.ledgerProposalEntryId ?? null,
          record.ledgerSettlementEntryId ?? null,
          record.proposedAt,
          record.paidAt ?? null
        ]
      );
      if (result.rows[0]) {
        return { record: payoutFromRow(result.rows[0]), created: true };
      }
    } catch (error) {
      mapPgError(error);
    }
    const existing = (await this.find({ triggerEventId: record.triggerEventId }))[0];
    return { record: existing ?? record, created: false };
  }

  async update(record: ParametricPayout): Promise<ParametricPayout> {
    await this.pool.query(
      `UPDATE insurance.payouts
         SET status = $2,
             ledger_proposal_entry_id = $3,
             ledger_settlement_entry_id = $4,
             paid_at = $5
       WHERE id = $1`,
      [
        record.id,
        record.status,
        record.ledgerProposalEntryId ?? null,
        record.ledgerSettlementEntryId ?? null,
        record.paidAt ?? null
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
}

export function createPgParametricPayoutRepository(pool: pg.Pool): PgParametricPayoutRepository {
  return new PgParametricPayoutRepository(pool);
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
