import { ConflictException } from '@nestjs/common';

/**
 * VSLA + carbon MRV persistence ports (wave VSLACARBON). Rows map to the
 * vsla_carbon schema (infra/postgres/037_vsla_carbon.sql). These tables hold
 * OPERATIONAL records only — every value movement posts through the
 * double-entry ledger (finance module) and is cross-referenced by
 * `ledgerEntryId`. Carbon figures are deterministic ESTIMATES from a
 * versioned coefficient table, never verification-grade credits. State
 * machines advance via compare-and-set (`updateExpected`) so concurrent
 * transitions surface as 409 instead of silently overwriting each other,
 * mirroring the agent-banking path.
 */

export const VSLA_GROUP_STATUSES = ['ACTIVE', 'DISSOLVED'] as const;
export type VslaGroupStatus = (typeof VSLA_GROUP_STATUSES)[number];

export const VSLA_MEMBER_ROLES = ['member', 'lead'] as const;
export type VslaMemberRole = (typeof VSLA_MEMBER_ROLES)[number];

export const VSLA_MEMBER_STATUSES = ['ACTIVE', 'EXITED'] as const;
export type VslaMemberStatus = (typeof VSLA_MEMBER_STATUSES)[number];

export const VSLA_CYCLE_STATUSES = ['OPEN', 'CLOSED'] as const;
export type VslaCycleStatus = (typeof VSLA_CYCLE_STATUSES)[number];

export const VSLA_LOAN_STATUSES = ['ACTIVE', 'REPAID'] as const;
export type VslaLoanStatus = (typeof VSLA_LOAN_STATUSES)[number];

export const CARBON_PRACTICE_TYPES = [
  'agroforestry',
  'fmnr',
  'woodlot',
  'conservation_agriculture'
] as const;
export type CarbonPracticeType = (typeof CARBON_PRACTICE_TYPES)[number];

export const CARBON_PLOT_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type CarbonPlotStatus = (typeof CARBON_PLOT_STATUSES)[number];

/** Honest provenance labels carried through evidence, estimates and reports. */
export const CARBON_BASIS_FLAGS = ['stub', 'estimate', 'live'] as const;
export type CarbonBasisFlag = (typeof CARBON_BASIS_FLAGS)[number];

export interface VslaGroupRecord {
  id: string;
  name: string;
  /** Optional chapter link (chapters model); standalone groups are valid. */
  chapterId?: string;
  leadUserId: string;
  status: VslaGroupStatus;
  /** Ledger asset account holding the pooled cash (vsla:<id>:cash). */
  savingsAccountCode: string;
  /** Ledger asset account for outstanding internal loans (vsla:<id>:loans_receivable). */
  loansReceivableAccountCode: string;
  /** Ledger revenue account for simple interest (vsla:<id>:interest_income). */
  interestIncomeAccountCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface VslaGroupCriteria {
  chapterId?: string;
  status?: VslaGroupStatus;
}

export interface VslaMemberRecord {
  id: string;
  groupId: string;
  userId: string;
  role: VslaMemberRole;
  status: VslaMemberStatus;
  joinedAt: string;
  exitedAt?: string;
}

export interface VslaMemberCriteria {
  groupId?: string;
  userId?: string;
  status?: VslaMemberStatus;
}

export interface VslaCycleRecord {
  id: string;
  groupId: string;
  label: string;
  status: VslaCycleStatus;
  openedAt: string;
  closedAt?: string;
  createdAt: string;
}

export interface VslaCycleCriteria {
  groupId?: string;
  status?: VslaCycleStatus;
}

export interface VslaContributionRecord {
  id: string;
  cycleId: string;
  groupId: string;
  memberId: string;
  amountKobo: number;
  /** UNIQUE — transport retries with the same key replay, never double-post. */
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaContributionCriteria {
  cycleId?: string;
  groupId?: string;
  memberId?: string;
}

/** Per-member share-out payout written at cycle close (deterministic pro-rata). */
export interface VslaShareOutRecord {
  id: string;
  cycleId: string;
  memberId: string;
  /** Amount actually paid out to the member's wallet at close. */
  shareKobo: number;
  /** Total the member contributed over the cycle. */
  contributedKobo: number;
  /** Liability left on the member account (loans outstanding against the pool). */
  residualKobo: number;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaShareOutCriteria {
  cycleId?: string;
  memberId?: string;
}

export interface VslaLoanRecord {
  id: string;
  groupId: string;
  cycleId: string;
  memberId: string;
  principalKobo: number;
  /** Simple interest rate in basis points charged once over the loan term. */
  interestRateBps: number;
  /** principal + principal * interestRateBps / 10_000 (integer math). */
  totalDueKobo: number;
  repaidKobo: number;
  status: VslaLoanStatus;
  issuedAt: string;
  repaidAt?: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaLoanCriteria {
  groupId?: string;
  cycleId?: string;
  memberId?: string;
  status?: VslaLoanStatus;
}

export interface VslaLoanRepaymentRecord {
  id: string;
  loanId: string;
  amountKobo: number;
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface VslaCarbonPlotRecord {
  id: string;
  groupId: string;
  ownerUserId: string;
  name: string;
  practiceType: CarbonPracticeType;
  /** Hectares * 100 (fixed-point) so estimate math stays exact. */
  hectaresCenti: number;
  centroidLat: number;
  centroidLong: number;
  /** H3 index at resolution 9, computed in the app layer (h3-js — no PostGIS). */
  h3Res9: string;
  status: CarbonPlotStatus;
  createdAt: string;
}

export interface VslaCarbonPlotCriteria {
  groupId?: string;
  ownerUserId?: string;
  status?: CarbonPlotStatus;
}

export interface CarbonEvidenceRecord {
  id: string;
  plotId: string;
  groupId: string;
  /** Season key, e.g. '2026-wet'. */
  season: string;
  submittedBy: string;
  submitterRole: 'farmer' | 'enumerator';
  /** Observed seedling/practice survival 0-100, optional. */
  survivalRatePct?: number;
  notes?: string;
  /** Optional Sentinel-2 NDVI linkage via the crop-ml contract. */
  ndviHealthScore?: number;
  ndviClassification?: string;
  /** Provenance of the NDVI linkage — 'stub'|'live', stored verbatim. */
  ndviBasis?: 'stub' | 'live';
  idempotencyKey: string;
  createdAt: string;
}

export interface CarbonEvidenceCriteria {
  plotId?: string;
  groupId?: string;
  season?: string;
}

export interface CarbonEstimateRecord {
  id: string;
  plotId: string;
  groupId: string;
  season: string;
  /** Version of the committed coefficient table used for this figure. */
  coefficientVersion: string;
  hectaresCenti: number;
  practiceType: CarbonPracticeType;
  survivalRatePct: number;
  seasonCount: number;
  /** Tonnes CO2e * 1000 (fixed-point). ALWAYS an estimate. */
  co2eMilliTonnes: number;
  basis: 'estimate';
  createdAt: string;
}

export interface CarbonEstimateCriteria {
  plotId?: string;
  groupId?: string;
  season?: string;
}

export interface VslaGroupRepository {
  create(record: VslaGroupRecord): Promise<VslaGroupRecord>;
  findById(id: string): Promise<VslaGroupRecord | undefined>;
  find(criteria: VslaGroupCriteria): Promise<VslaGroupRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<VslaGroupRecord>,
    expected: Partial<VslaGroupRecord>
  ): Promise<VslaGroupRecord>;
}

export interface VslaMemberRepository {
  create(record: VslaMemberRecord): Promise<VslaMemberRecord>;
  findById(id: string): Promise<VslaMemberRecord | undefined>;
  findByGroupAndUser(groupId: string, userId: string): Promise<VslaMemberRecord | undefined>;
  find(criteria: VslaMemberCriteria): Promise<VslaMemberRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<VslaMemberRecord>,
    expected: Partial<VslaMemberRecord>
  ): Promise<VslaMemberRecord>;
}

export interface VslaCycleRepository {
  create(record: VslaCycleRecord): Promise<VslaCycleRecord>;
  findById(id: string): Promise<VslaCycleRecord | undefined>;
  findOpenByGroup(groupId: string): Promise<VslaCycleRecord | undefined>;
  find(criteria: VslaCycleCriteria): Promise<VslaCycleRecord[]>;
  /** Compare-and-set on status; throws ConflictException when it moved on. */
  updateExpected(
    id: string,
    patch: Partial<VslaCycleRecord>,
    expected: Partial<VslaCycleRecord>
  ): Promise<VslaCycleRecord>;
}

export interface VslaContributionRepository {
  /** Throws ConflictException when idempotencyKey already exists. */
  create(record: VslaContributionRecord): Promise<VslaContributionRecord>;
  findByIdempotencyKey(key: string): Promise<VslaContributionRecord | undefined>;
  find(criteria: VslaContributionCriteria): Promise<VslaContributionRecord[]>;
}

export interface VslaShareOutRepository {
  create(record: VslaShareOutRecord): Promise<VslaShareOutRecord>;
  find(criteria: VslaShareOutCriteria): Promise<VslaShareOutRecord[]>;
}

export interface VslaLoanRepository {
  create(record: VslaLoanRecord): Promise<VslaLoanRecord>;
  findById(id: string): Promise<VslaLoanRecord | undefined>;
  find(criteria: VslaLoanCriteria): Promise<VslaLoanRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<VslaLoanRecord>,
    expected: Partial<VslaLoanRecord>
  ): Promise<VslaLoanRecord>;
}

export interface VslaLoanRepaymentRepository {
  /** Throws ConflictException when idempotencyKey already exists. */
  create(record: VslaLoanRepaymentRecord): Promise<VslaLoanRepaymentRecord>;
  findByIdempotencyKey(key: string): Promise<VslaLoanRepaymentRecord | undefined>;
  findByLoan(loanId: string): Promise<VslaLoanRepaymentRecord[]>;
}

export interface CarbonPlotRepository {
  create(record: VslaCarbonPlotRecord): Promise<VslaCarbonPlotRecord>;
  findById(id: string): Promise<VslaCarbonPlotRecord | undefined>;
  find(criteria: VslaCarbonPlotCriteria): Promise<VslaCarbonPlotRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<VslaCarbonPlotRecord>,
    expected: Partial<VslaCarbonPlotRecord>
  ): Promise<VslaCarbonPlotRecord>;
}

export interface CarbonEvidenceRepository {
  /** Throws ConflictException when idempotencyKey already exists. */
  create(record: CarbonEvidenceRecord): Promise<CarbonEvidenceRecord>;
  findByIdempotencyKey(key: string): Promise<CarbonEvidenceRecord | undefined>;
  find(criteria: CarbonEvidenceCriteria): Promise<CarbonEvidenceRecord[]>;
}

export interface CarbonEstimateRepository {
  /** Throws ConflictException on the (plot_id, season, coefficient_version) unique key. */
  create(record: CarbonEstimateRecord): Promise<CarbonEstimateRecord>;
  findByPlotSeasonVersion(
    plotId: string,
    season: string,
    version: string
  ): Promise<CarbonEstimateRecord | undefined>;
  find(criteria: CarbonEstimateCriteria): Promise<CarbonEstimateRecord[]>;
}

/* ------------------------------ in-memory ------------------------------ */

export class InMemoryVslaGroupRepository implements VslaGroupRepository {
  private readonly items = new Map<string, VslaGroupRecord>();

  async create(record: VslaGroupRecord): Promise<VslaGroupRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VslaGroupRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaGroupCriteria): Promise<VslaGroupRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.chapterId || item.chapterId === criteria.chapterId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaGroupRecord>,
    expected: Partial<VslaGroupRecord>
  ): Promise<VslaGroupRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`VSLA group '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof VslaGroupRecord] !== value) {
        throw new ConflictException(`VSLA group '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryVslaMemberRepository implements VslaMemberRepository {
  private readonly items = new Map<string, VslaMemberRecord>();

  async create(record: VslaMemberRecord): Promise<VslaMemberRecord> {
    for (const existing of this.items.values()) {
      if (existing.groupId === record.groupId && existing.userId === record.userId) {
        throw new ConflictException('This user is already a member of the group');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VslaMemberRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByGroupAndUser(groupId: string, userId: string): Promise<VslaMemberRecord | undefined> {
    const record = [...this.items.values()].find(
      (item) => item.groupId === groupId && item.userId === userId
    );
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaMemberCriteria): Promise<VslaMemberRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.userId || item.userId === criteria.userId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaMemberRecord>,
    expected: Partial<VslaMemberRecord>
  ): Promise<VslaMemberRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`VSLA member '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof VslaMemberRecord] !== value) {
        throw new ConflictException(`VSLA member '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryVslaCycleRepository implements VslaCycleRepository {
  private readonly items = new Map<string, VslaCycleRecord>();

  async create(record: VslaCycleRecord): Promise<VslaCycleRecord> {
    // Mirror the pg partial unique index: at most one OPEN cycle per group.
    for (const existing of this.items.values()) {
      if (
        existing.groupId === record.groupId &&
        existing.status === 'OPEN' &&
        record.status === 'OPEN'
      ) {
        throw new ConflictException('The group already has an open cycle');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VslaCycleRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findOpenByGroup(groupId: string): Promise<VslaCycleRecord | undefined> {
    const record = [...this.items.values()].find(
      (item) => item.groupId === groupId && item.status === 'OPEN'
    );
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaCycleCriteria): Promise<VslaCycleRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaCycleRecord>,
    expected: Partial<VslaCycleRecord>
  ): Promise<VslaCycleRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`VSLA cycle '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof VslaCycleRecord] !== value) {
        throw new ConflictException(`VSLA cycle '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryVslaContributionRepository implements VslaContributionRepository {
  private readonly items = new Map<string, VslaContributionRecord>();

  async create(record: VslaContributionRecord): Promise<VslaContributionRecord> {
    // Mirror the pg UNIQUE constraint on idempotency_key.
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<VslaContributionRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaContributionCriteria): Promise<VslaContributionRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.cycleId || item.cycleId === criteria.cycleId) &&
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.memberId || item.memberId === criteria.memberId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export class InMemoryVslaShareOutRepository implements VslaShareOutRepository {
  private readonly items = new Map<string, VslaShareOutRecord>();

  async create(record: VslaShareOutRecord): Promise<VslaShareOutRecord> {
    for (const existing of this.items.values()) {
      if (existing.cycleId === record.cycleId && existing.memberId === record.memberId) {
        throw new ConflictException('Share-out already recorded for this member');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async find(criteria: VslaShareOutCriteria): Promise<VslaShareOutRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.cycleId || item.cycleId === criteria.cycleId) &&
          (!criteria.memberId || item.memberId === criteria.memberId)
      )
      .map((item) => structuredClone(item));
  }
}

export class InMemoryVslaLoanRepository implements VslaLoanRepository {
  private readonly items = new Map<string, VslaLoanRecord>();

  async create(record: VslaLoanRecord): Promise<VslaLoanRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VslaLoanRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaLoanCriteria): Promise<VslaLoanRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.cycleId || item.cycleId === criteria.cycleId) &&
          (!criteria.memberId || item.memberId === criteria.memberId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaLoanRecord>,
    expected: Partial<VslaLoanRecord>
  ): Promise<VslaLoanRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`VSLA loan '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof VslaLoanRecord] !== value) {
        throw new ConflictException(`VSLA loan '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryVslaLoanRepaymentRepository implements VslaLoanRepaymentRepository {
  private readonly items = new Map<string, VslaLoanRepaymentRecord>();

  async create(record: VslaLoanRepaymentRecord): Promise<VslaLoanRepaymentRecord> {
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<VslaLoanRepaymentRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async findByLoan(loanId: string): Promise<VslaLoanRepaymentRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.loanId === loanId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export class InMemoryCarbonPlotRepository implements CarbonPlotRepository {
  private readonly items = new Map<string, VslaCarbonPlotRecord>();

  async create(record: VslaCarbonPlotRecord): Promise<VslaCarbonPlotRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VslaCarbonPlotRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: VslaCarbonPlotCriteria): Promise<VslaCarbonPlotRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.ownerUserId || item.ownerUserId === criteria.ownerUserId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<VslaCarbonPlotRecord>,
    expected: Partial<VslaCarbonPlotRecord>
  ): Promise<VslaCarbonPlotRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Carbon plot '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof VslaCarbonPlotRecord] !== value) {
        throw new ConflictException(`Carbon plot '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryCarbonEvidenceRepository implements CarbonEvidenceRepository {
  private readonly items = new Map<string, CarbonEvidenceRecord>();

  async create(record: CarbonEvidenceRecord): Promise<CarbonEvidenceRecord> {
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<CarbonEvidenceRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: CarbonEvidenceCriteria): Promise<CarbonEvidenceRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.plotId || item.plotId === criteria.plotId) &&
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.season || item.season === criteria.season)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export class InMemoryCarbonEstimateRepository implements CarbonEstimateRepository {
  private readonly items = new Map<string, CarbonEstimateRecord>();

  async create(record: CarbonEstimateRecord): Promise<CarbonEstimateRecord> {
    for (const existing of this.items.values()) {
      if (
        existing.plotId === record.plotId &&
        existing.season === record.season &&
        existing.coefficientVersion === record.coefficientVersion
      ) {
        throw new ConflictException('An estimate already exists for this plot and season');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByPlotSeasonVersion(
    plotId: string,
    season: string,
    version: string
  ): Promise<CarbonEstimateRecord | undefined> {
    const record = [...this.items.values()].find(
      (item) =>
        item.plotId === plotId && item.season === season && item.coefficientVersion === version
    );
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: CarbonEstimateCriteria): Promise<CarbonEstimateRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.plotId || item.plotId === criteria.plotId) &&
          (!criteria.groupId || item.groupId === criteria.groupId) &&
          (!criteria.season || item.season === criteria.season)
      )
      .map((item) => structuredClone(item));
  }
}

/* ------------------------------ factories ------------------------------ */

export function createInMemoryVslaGroupRepository(): InMemoryVslaGroupRepository {
  return new InMemoryVslaGroupRepository();
}

export function createInMemoryVslaMemberRepository(): InMemoryVslaMemberRepository {
  return new InMemoryVslaMemberRepository();
}

export function createInMemoryVslaCycleRepository(): InMemoryVslaCycleRepository {
  return new InMemoryVslaCycleRepository();
}

export function createInMemoryVslaContributionRepository(): InMemoryVslaContributionRepository {
  return new InMemoryVslaContributionRepository();
}

export function createInMemoryVslaShareOutRepository(): InMemoryVslaShareOutRepository {
  return new InMemoryVslaShareOutRepository();
}

export function createInMemoryVslaLoanRepository(): InMemoryVslaLoanRepository {
  return new InMemoryVslaLoanRepository();
}

export function createInMemoryVslaLoanRepaymentRepository(): InMemoryVslaLoanRepaymentRepository {
  return new InMemoryVslaLoanRepaymentRepository();
}

export function createInMemoryCarbonPlotRepository(): InMemoryCarbonPlotRepository {
  return new InMemoryCarbonPlotRepository();
}

export function createInMemoryCarbonEvidenceRepository(): InMemoryCarbonEvidenceRepository {
  return new InMemoryCarbonEvidenceRepository();
}

export function createInMemoryCarbonEstimateRepository(): InMemoryCarbonEstimateRepository {
  return new InMemoryCarbonEstimateRepository();
}
