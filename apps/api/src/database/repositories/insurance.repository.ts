import type {
  FloodSeverityRank,
  ParametricPayout,
  ParametricPolicy,
  ParametricPolicyStatus,
  ParametricProduct,
  ParametricTriggerEvent
} from '@agric-platform/shared';
import { ConflictException } from '@nestjs/common';

/**
 * Parametric insurance persistence ports (wave-insurance, migration 031,
 * schema `insurance`). In-memory implementations mirror the pg semantics so
 * unit tests keep full fidelity; production swaps them behind the same port
 * via the DatabaseModule factories. Upsert semantics mirror the unique
 * indexes: products by code, trigger events by (policyId,
 * evidenceFingerprint), payouts by triggerEventId — deterministic
 * re-evaluation is a no-op.
 */

export interface ParametricProductCriteria {
  code?: string;
  peril?: string;
}

export interface ParametricProductRepository {
  /** Insert or replace the row matching the product code (catalog seed). */
  upsert(record: ParametricProduct): Promise<ParametricProduct>;
  find(criteria: ParametricProductCriteria): Promise<ParametricProduct[]>;
  findOne(criteria: ParametricProductCriteria): Promise<ParametricProduct | undefined>;
  findById(id: string): Promise<ParametricProduct | undefined>;
  all(): Promise<ParametricProduct[]>;
}

export function insuranceProductMatcher(
  criteria: ParametricProductCriteria
): (record: ParametricProduct) => boolean {
  return (record) =>
    (!criteria.code || record.code === criteria.code) &&
    (!criteria.peril || record.peril === criteria.peril);
}

export class InMemoryParametricProductRepository implements ParametricProductRepository {
  private readonly items = new Map<string, ParametricProduct>();

  upsert(record: ParametricProduct): Promise<ParametricProduct> {
    const existing = [...this.items.values()].find((item) => item.code === record.code);
    this.items.set(existing?.id ?? record.id, structuredClone(record));
    return Promise.resolve(record);
  }

  find(criteria: ParametricProductCriteria): Promise<ParametricProduct[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insuranceProductMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findOne(criteria: ParametricProductCriteria): Promise<ParametricProduct | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<ParametricProduct | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricProduct[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricProductRepository(): InMemoryParametricProductRepository {
  return new InMemoryParametricProductRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricPolicyCriteria {
  farmerUserId?: string;
  status?: ParametricPolicyStatus;
  season?: string;
  plotId?: string;
}

export interface ParametricPolicyRepository {
  create(record: ParametricPolicy): Promise<ParametricPolicy>;
  update(record: ParametricPolicy): Promise<ParametricPolicy>;
  /**
   * Compare-and-set status transition: applies `patch` only when the stored
   * row still has `expectedStatus`; throws ConflictException (409) otherwise
   * so illegal/concurrent transitions never double-fire.
   */
  transition(
    id: string,
    expectedStatus: ParametricPolicyStatus,
    patch: Partial<ParametricPolicy>
  ): Promise<ParametricPolicy>;
  find(criteria: ParametricPolicyCriteria): Promise<ParametricPolicy[]>;
  findById(id: string): Promise<ParametricPolicy | undefined>;
  all(): Promise<ParametricPolicy[]>;
}

export function insurancePolicyMatcher(
  criteria: ParametricPolicyCriteria
): (record: ParametricPolicy) => boolean {
  return (record) =>
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.season || record.season === criteria.season) &&
    (!criteria.plotId || record.plotId === criteria.plotId);
}

export class InMemoryParametricPolicyRepository implements ParametricPolicyRepository {
  private readonly items = new Map<string, ParametricPolicy>();

  create(record: ParametricPolicy): Promise<ParametricPolicy> {
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve(record);
  }

  async update(record: ParametricPolicy): Promise<ParametricPolicy> {
    await this.get(record.id);
    this.items.set(record.id, structuredClone(record));
    return record;
  }

  /**
   * Synchronous check-and-set (no await between read and write) so the
   * precondition cannot be defeated by a concurrent transition — mirrors the
   * guarded SQL UPDATE in the pg implementation.
   */
  transition(
    id: string,
    expectedStatus: ParametricPolicyStatus,
    patch: Partial<ParametricPolicy>
  ): Promise<ParametricPolicy> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Insurance policy '${id}' not found`);
    }
    if (current.status !== expectedStatus) {
      throw new ConflictException(
        `Insurance policy '${id}' is '${current.status}', not '${expectedStatus}'`
      );
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return Promise.resolve(structuredClone(next));
  }

  find(criteria: ParametricPolicyCriteria): Promise<ParametricPolicy[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insurancePolicyMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricPolicy | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricPolicy[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }

  private async get(id: string): Promise<ParametricPolicy> {
    const item = await this.findById(id);
    if (!item) {
      throw new ConflictException(`Insurance policy '${id}' not found`);
    }
    return item;
  }
}

export function createInMemoryParametricPolicyRepository(): InMemoryParametricPolicyRepository {
  return new InMemoryParametricPolicyRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricTriggerEventCriteria {
  policyId?: string;
  farmerUserId?: string;
  evidenceFingerprint?: string;
}

export interface ParametricTriggerEventRepository {
  /**
   * Insert or return the row matching (policyId, evidenceFingerprint):
   * re-running the deterministic evaluation with unchanged inputs replays
   * the original event instead of duplicating it.
   */
  upsert(record: ParametricTriggerEvent): Promise<{ record: ParametricTriggerEvent; created: boolean }>;
  find(criteria: ParametricTriggerEventCriteria): Promise<ParametricTriggerEvent[]>;
  findById(id: string): Promise<ParametricTriggerEvent | undefined>;
  all(): Promise<ParametricTriggerEvent[]>;
}

export function insuranceTriggerEventMatcher(
  criteria: ParametricTriggerEventCriteria
): (record: ParametricTriggerEvent) => boolean {
  return (record) =>
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.evidenceFingerprint || record.evidenceFingerprint === criteria.evidenceFingerprint);
}

export class InMemoryParametricTriggerEventRepository implements ParametricTriggerEventRepository {
  private readonly items = new Map<string, ParametricTriggerEvent>();

  upsert(
    record: ParametricTriggerEvent
  ): Promise<{ record: ParametricTriggerEvent; created: boolean }> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.policyId === record.policyId &&
        item.evidenceFingerprint === record.evidenceFingerprint
    );
    if (existing) {
      return Promise.resolve({ record: structuredClone(existing), created: false });
    }
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve({ record, created: true });
  }

  find(criteria: ParametricTriggerEventCriteria): Promise<ParametricTriggerEvent[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insuranceTriggerEventMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricTriggerEvent | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricTriggerEvent[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricTriggerEventRepository(): InMemoryParametricTriggerEventRepository {
  return new InMemoryParametricTriggerEventRepository();
}

// ---------------------------------------------------------------------------

export interface ParametricPayoutCriteria {
  policyId?: string;
  farmerUserId?: string;
  status?: ParametricPayout['status'];
  triggerEventId?: string;
}

export interface ParametricPayoutRepository {
  /** Insert or return the row matching triggerEventId (one payout per trigger). */
  upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }>;
  update(record: ParametricPayout): Promise<ParametricPayout>;
  find(criteria: ParametricPayoutCriteria): Promise<ParametricPayout[]>;
  findById(id: string): Promise<ParametricPayout | undefined>;
  all(): Promise<ParametricPayout[]>;
}

export function insurancePayoutMatcher(
  criteria: ParametricPayoutCriteria
): (record: ParametricPayout) => boolean {
  return (record) =>
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
    (!criteria.status || record.status === criteria.status) &&
    (!criteria.triggerEventId || record.triggerEventId === criteria.triggerEventId);
}

export class InMemoryParametricPayoutRepository implements ParametricPayoutRepository {
  private readonly items = new Map<string, ParametricPayout>();

  upsert(record: ParametricPayout): Promise<{ record: ParametricPayout; created: boolean }> {
    const existing = [...this.items.values()].find(
      (item) => item.triggerEventId === record.triggerEventId
    );
    if (existing) {
      return Promise.resolve({ record: structuredClone(existing), created: false });
    }
    this.items.set(record.id, structuredClone(record));
    return Promise.resolve({ record, created: true });
  }

  async update(record: ParametricPayout): Promise<ParametricPayout> {
    const current = this.items.get(record.id);
    if (!current) {
      throw new ConflictException(`Insurance payout '${record.id}' not found`);
    }
    this.items.set(record.id, structuredClone(record));
    return record;
  }

  find(criteria: ParametricPayoutCriteria): Promise<ParametricPayout[]> {
    return Promise.resolve(
      [...this.items.values()]
        .filter(insurancePayoutMatcher(criteria))
        .map((item) => structuredClone(item))
    );
  }

  async findById(id: string): Promise<ParametricPayout | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  all(): Promise<ParametricPayout[]> {
    return Promise.resolve([...this.items.values()].map((item) => structuredClone(item)));
  }
}

export function createInMemoryParametricPayoutRepository(): InMemoryParametricPayoutRepository {
  return new InMemoryParametricPayoutRepository();
}

// ---------------------------------------------------------------------------
// Stage 27 (Insurance-in-the-Bag, migration 057): voucher-bundled cover.

export const RIDER_STATUSES = ['active', 'suspended'] as const;
export type RiderStatus = (typeof RIDER_STATUSES)[number];

/**
 * Per-programme insurance rider (Stage 27): the sponsor-defined product
 * terms that bind a micro-parametric cover onto every redeemed voucher of
 * the programme. One rider per programme (UNIQUE programme_id). The flood
 * band is captured at definition time so redemption-time premium pricing
 * stays deterministic (the stub flood driver is never consulted on the
 * money path).
 */
export interface VoucherProgrammeRiderRecord {
  id: string;
  /** UNIQUE — one rider per subsidy programme. */
  programmeId: string;
  /** Catalog product code (trigger type source), e.g. 'NG-RAIN-WET-26'. */
  productCode: string;
  sumInsuredKobo: number;
  premiumRateBps: number;
  floodBand: FloodSeverityRank;
  status: RiderStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoucherProgrammeRiderRepository {
  /** Throws ConflictException when a rider already exists for the programme. */
  create(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord>;
  update(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord>;
  findById(id: string): Promise<VoucherProgrammeRiderRecord | undefined>;
  findByProgrammeId(programmeId: string): Promise<VoucherProgrammeRiderRecord | undefined>;
  all(): Promise<VoucherProgrammeRiderRecord[]>;
}

export class InMemoryVoucherProgrammeRiderRepository implements VoucherProgrammeRiderRepository {
  private readonly items = new Map<string, VoucherProgrammeRiderRecord>();

  async create(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord> {
    for (const existing of this.items.values()) {
      if (existing.programmeId === record.programmeId) {
        throw new ConflictException(`Programme '${record.programmeId}' already has an insurance rider`);
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async update(record: VoucherProgrammeRiderRecord): Promise<VoucherProgrammeRiderRecord> {
    if (!this.items.has(record.id)) {
      throw new ConflictException(`Insurance rider '${record.id}' not found`);
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VoucherProgrammeRiderRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByProgrammeId(programmeId: string): Promise<VoucherProgrammeRiderRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.programmeId === programmeId);
    return record ? structuredClone(record) : undefined;
  }

  async all(): Promise<VoucherProgrammeRiderRecord[]> {
    return [...this.items.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export function createInMemoryVoucherProgrammeRiderRepository(): InMemoryVoucherProgrammeRiderRepository {
  return new InMemoryVoucherProgrammeRiderRepository();
}

// ---------------------------------------------------------------------------

export const VOUCHER_COVER_STATUSES = ['quoted', 'bound', 'expired', 'triggered', 'paid'] as const;
export type VoucherCoverStatus = (typeof VOUCHER_COVER_STATUSES)[number];

/**
 * Cover bound onto a redeemed voucher (Stage 27). UNIQUE voucher_id makes
 * the bind exactly-once per voucher behind the redemption state machine
 * (crash-resume replays adopt the existing row instead of double-binding);
 * UNIQUE policy_id pins the 1:1 link to the parametric policy whose
 * lifecycle drives the triggered/paid projections. Status is projected
 * from policy lifecycle events; persisted rows start at 'bound' because
 * pricing ('quoted') is atomic with binding on the redemption path.
 */
export interface VoucherCoverRecord {
  id: string;
  /** UNIQUE — one cover per voucher, ever. */
  voucherId: string;
  /** UNIQUE — the bound parametric policy. */
  policyId: string;
  programmeId: string;
  plotId: string;
  farmerId: string;
  premiumKobo: number;
  /** Honest provenance label — 'stub' until the live weather provider gate. */
  coverBasis: 'stub' | 'live';
  status: VoucherCoverStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VoucherCoverCriteria {
  voucherId?: string;
  policyId?: string;
  programmeId?: string;
  farmerId?: string;
  status?: VoucherCoverStatus;
}

export interface VoucherCoverRepository {
  /** Throws ConflictException when voucherId or policyId already exists. */
  create(record: VoucherCoverRecord): Promise<VoucherCoverRecord>;
  /** Compare-and-set; throws ConflictException when the row moved on. */
  updateExpected(
    id: string,
    patch: Partial<VoucherCoverRecord>,
    expected: Partial<VoucherCoverRecord>
  ): Promise<VoucherCoverRecord>;
  findById(id: string): Promise<VoucherCoverRecord | undefined>;
  findByVoucherId(voucherId: string): Promise<VoucherCoverRecord | undefined>;
  find(criteria: VoucherCoverCriteria): Promise<VoucherCoverRecord[]>;
  all(): Promise<VoucherCoverRecord[]>;
}

export function voucherCoverMatcher(criteria: VoucherCoverCriteria): (record: VoucherCoverRecord) => boolean {
  return (record) =>
    (!criteria.voucherId || record.voucherId === criteria.voucherId) &&
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.programmeId || record.programmeId === criteria.programmeId) &&
    (!criteria.farmerId || record.farmerId === criteria.farmerId) &&
    (!criteria.status || record.status === criteria.status);
}

export class InMemoryVoucherCoverRepository implements VoucherCoverRepository {
  private readonly items = new Map<string, VoucherCoverRecord>();

  async create(record: VoucherCoverRecord): Promise<VoucherCoverRecord> {
    for (const existing of this.items.values()) {
      if (existing.voucherId === record.voucherId) {
        throw new ConflictException(`Voucher '${record.voucherId}' already has a bound cover`);
      }
      if (existing.policyId === record.policyId) {
        throw new ConflictException(`Policy '${record.policyId}' is already linked to a cover`);
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  /**
   * Synchronous check-and-set (no await between read and write) so the
   * precondition cannot be defeated by a concurrent projection — mirrors
   * the guarded SQL UPDATE in the pg implementation.
   */
  updateExpected(
    id: string,
    patch: Partial<VoucherCoverRecord>,
    expected: Partial<VoucherCoverRecord>
  ): Promise<VoucherCoverRecord> {
    const current = this.items.get(id);
    const matchesExpected = current
      ? Object.entries(expected).every(([key, value]) => current[key as keyof VoucherCoverRecord] === value)
      : false;
    if (!current || !matchesExpected) {
      throw new ConflictException(`Voucher cover '${id}' changed concurrently; reload and retry`);
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return Promise.resolve(structuredClone(updated));
  }

  async findById(id: string): Promise<VoucherCoverRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByVoucherId(voucherId: string): Promise<VoucherCoverRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.voucherId === voucherId);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VoucherCoverCriteria): Promise<VoucherCoverRecord[]> {
    return [...this.items.values()]
      .filter(voucherCoverMatcher(criteria))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async all(): Promise<VoucherCoverRecord[]> {
    return [...this.items.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export function createInMemoryVoucherCoverRepository(): InMemoryVoucherCoverRepository {
  return new InMemoryVoucherCoverRepository();
}


// ---------------------------------------------------------------------------
// Stage 27 (Regen Discount, migration 070): carbon-MRV-verified premium
// discount — versioned admin rate card + one discount per policy.

/**
 * One version of the regen-discount rate card. Append-only: every admin
 * change inserts a new row with a monotonically increasing version so the
 * terms that priced any historical policy stay reproducible; the current
 * card is the highest version. Bounded 0..5000 bps (mirrors
 * MAX_REGEN_DISCOUNT_BPS in premium.ts and the CHECK in migration 070).
 */
export interface RegenDiscountRateCardRecord {
  version: number;
  discountBps: number;
  setBy: string;
  createdAt: string;
}

export interface RegenDiscountRateCardRepository {
  /** Append-only; throws ConflictException when the version already exists. */
  append(record: RegenDiscountRateCardRecord): Promise<RegenDiscountRateCardRecord>;
  /** Highest-version row (the current card), if any has been set. */
  current(): Promise<RegenDiscountRateCardRecord | undefined>;
  all(): Promise<RegenDiscountRateCardRecord[]>;
}

export class InMemoryRegenDiscountRateCardRepository implements RegenDiscountRateCardRepository {
  private readonly items = new Map<number, RegenDiscountRateCardRecord>();

  async append(record: RegenDiscountRateCardRecord): Promise<RegenDiscountRateCardRecord> {
    if (this.items.has(record.version)) {
      throw new ConflictException(`Regen rate-card version ${record.version} already exists`);
    }
    this.items.set(record.version, structuredClone(record));
    return structuredClone(record);
  }

  async current(): Promise<RegenDiscountRateCardRecord | undefined> {
    const versions = [...this.items.keys()].sort((a, b) => b - a);
    const record = versions.length > 0 ? this.items.get(versions[0]) : undefined;
    return record ? structuredClone(record) : undefined;
  }

  async all(): Promise<RegenDiscountRateCardRecord[]> {
    return [...this.items.values()]
      .sort((a, b) => a.version - b.version)
      .map((item) => structuredClone(item));
  }
}

export function createInMemoryRegenDiscountRateCardRepository(): InMemoryRegenDiscountRateCardRepository {
  return new InMemoryRegenDiscountRateCardRepository();
}

// ---------------------------------------------------------------------------

/** Honest provenance of the discount evidence (never upgraded). */
export type RegenEvidenceBasis = 'live' | 'estimate';

/**
 * The regen discount applied to a policy (Stage 27). UNIQUE policy_id
 * makes the discount exactly-once per policy; attestationId pins the
 * vsla-carbon seasonal evidence row that established eligibility (a real,
 * recorded attestation — never a fabricated satellite score);
 * rateCardVersion pins the rate-card version that priced the policy.
 */
export interface RegenDiscountRecord {
  id: string;
  /** UNIQUE — one discount per policy, ever. */
  policyId: string;
  /** The insured farm plot the discounted premium attaches to. */
  plotId: string;
  /** FK to vsla_carbon.carbon_evidence — the eligibility attestation. */
  attestationId: string;
  discountBps: number;
  discountKobo: number;
  rateCardVersion: number;
  evidenceBasis: RegenEvidenceBasis;
  appliedAt: string;
}

export interface RegenDiscountCriteria {
  policyId?: string;
  plotId?: string;
  attestationId?: string;
  evidenceBasis?: RegenEvidenceBasis;
}

export interface RegenDiscountRepository {
  /** Throws ConflictException when policyId already has a discount. */
  create(record: RegenDiscountRecord): Promise<RegenDiscountRecord>;
  findByPolicyId(policyId: string): Promise<RegenDiscountRecord | undefined>;
  find(criteria: RegenDiscountCriteria): Promise<RegenDiscountRecord[]>;
  all(): Promise<RegenDiscountRecord[]>;
}

export function regenDiscountMatcher(criteria: RegenDiscountCriteria): (record: RegenDiscountRecord) => boolean {
  return (record) =>
    (!criteria.policyId || record.policyId === criteria.policyId) &&
    (!criteria.plotId || record.plotId === criteria.plotId) &&
    (!criteria.attestationId || record.attestationId === criteria.attestationId) &&
    (!criteria.evidenceBasis || record.evidenceBasis === criteria.evidenceBasis);
}

export class InMemoryRegenDiscountRepository implements RegenDiscountRepository {
  private readonly items = new Map<string, RegenDiscountRecord>();

  async create(record: RegenDiscountRecord): Promise<RegenDiscountRecord> {
    for (const existing of this.items.values()) {
      if (existing.policyId === record.policyId) {
        throw new ConflictException(`Policy '${record.policyId}' already has a regen discount`);
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByPolicyId(policyId: string): Promise<RegenDiscountRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.policyId === policyId);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: RegenDiscountCriteria): Promise<RegenDiscountRecord[]> {
    return [...this.items.values()]
      .filter(regenDiscountMatcher(criteria))
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
      .map((item) => structuredClone(item));
  }

  async all(): Promise<RegenDiscountRecord[]> {
    return [...this.items.values()]
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt))
      .map((item) => structuredClone(item));
  }
}

export function createInMemoryRegenDiscountRepository(): InMemoryRegenDiscountRepository {
  return new InMemoryRegenDiscountRepository();
}
