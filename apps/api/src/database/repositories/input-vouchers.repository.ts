import { ConflictException } from '@nestjs/common';

/**
 * Input-subsidy e-voucher persistence ports (wave NINVOUCHER). Rows map to
 * the input_vouchers schema (infra/postgres/035_input_vouchers.sql). These
 * tables hold OPERATIONAL records only — the budget envelope, outstanding
 * liability and supplier receivables post through the double-entry ledger
 * (finance module) and are cross-referenced by `ledgerEntryId`. State
 * machines advance via compare-and-set (`updateExpected`) so concurrent
 * transitions surface as 409 instead of silently overwriting each other.
 *
 * Data protection: the full NIN is NEVER persisted — only the salted
 * HMAC-SHA256 hash (`ninHash`) and the last-3 mask (`ninMask`).
 */

export const PROGRAMME_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED'] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

export const INPUT_VOUCHER_STATUSES = ['ISSUED', 'REDEEMED', 'EXPIRED', 'VOIDED'] as const;
export type InputVoucherStatus = (typeof INPUT_VOUCHER_STATUSES)[number];

export const VERIFICATION_BASES = ['stub', 'live'] as const;
export type VerificationBasis = (typeof VERIFICATION_BASES)[number];

export interface SubsidyProgrammeRecord {
  id: string;
  name: string;
  sponsor: string;
  description?: string;
  status: ProgrammeStatus;
  perFarmerCapKobo: number;
  budgetKobo: number;
  /** Empty array = all states eligible. */
  eligibleStates: string[];
  /** Empty array = all crops eligible. */
  eligibleCrops: string[];
  /** Ledger liability account backing the budget envelope (programme:<id>:liability). */
  liabilityAccountCode: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProgrammeCriteria {
  status?: ProgrammeStatus;
}

export interface BeneficiaryRecord {
  id: string;
  programmeId: string;
  farmerId: string;
  /** Salted HMAC-SHA256 of the normalised NIN — never the plaintext NIN. */
  ninHash: string;
  /** Last-3 mask for operator display (e.g. '********123'). */
  ninMask: string;
  /** Honest provenance label of the identity verification. */
  verificationBasis: VerificationBasis;
  nameMatchScore?: number;
  state?: string;
  primaryCrop?: string;
  verifiedAt: string;
  createdAt: string;
}

export interface BeneficiaryCriteria {
  programmeId?: string;
  farmerId?: string;
}

export interface InputVoucherRecord {
  id: string;
  programmeId: string;
  beneficiaryId: string;
  farmerId: string;
  amountKobo: number;
  status: InputVoucherStatus;
  /** UNIQUE — allocation retries with the same key replay, never double-issue. */
  idempotencyKey: string;
  expiresAt: string;
  distributedAt?: string;
  redeemedAt?: string;
  voidedAt?: string;
  /** Redemption ledger entry id (set on REDEEMED). */
  ledgerEntryId?: string;
  createdAt: string;
}

export interface InputVoucherCriteria {
  programmeId?: string;
  beneficiaryId?: string;
  farmerId?: string;
  status?: InputVoucherStatus;
}

export interface RedemptionRecord {
  id: string;
  /** UNIQUE — hard anti-double-spend constraint behind the status machine. */
  voucherId: string;
  programmeId: string;
  supplierId: string;
  invoiceRef: string;
  amountKobo: number;
  /** UNIQUE — transport retries replay, never double-post. */
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
}

export interface RedemptionCriteria {
  voucherId?: string;
  programmeId?: string;
  supplierId?: string;
}

export interface SubsidyProgrammeRepository {
  create(record: SubsidyProgrammeRecord): Promise<SubsidyProgrammeRecord>;
  findById(id: string): Promise<SubsidyProgrammeRecord | undefined>;
  find(criteria: ProgrammeCriteria): Promise<SubsidyProgrammeRecord[]>;
  updateExpected(
    id: string,
    patch: Partial<SubsidyProgrammeRecord>,
    expected: Partial<SubsidyProgrammeRecord>
  ): Promise<SubsidyProgrammeRecord>;
}

export interface BeneficiaryRepository {
  /** Throws ConflictException on duplicate (programmeId, farmerId) or (programmeId, ninHash). */
  create(record: BeneficiaryRecord): Promise<BeneficiaryRecord>;
  findById(id: string): Promise<BeneficiaryRecord | undefined>;
  findByProgrammeAndFarmer(programmeId: string, farmerId: string): Promise<BeneficiaryRecord | undefined>;
  find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]>;
}

export interface InputVoucherRepository {
  /** Throws ConflictException when idempotencyKey already exists. */
  create(record: InputVoucherRecord): Promise<InputVoucherRecord>;
  findById(id: string): Promise<InputVoucherRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<InputVoucherRecord | undefined>;
  find(criteria: InputVoucherCriteria): Promise<InputVoucherRecord[]>;
  /** Compare-and-set; throws ConflictException when the row moved on. */
  updateExpected(
    id: string,
    patch: Partial<InputVoucherRecord>,
    expected: Partial<InputVoucherRecord>
  ): Promise<InputVoucherRecord>;
}

export interface RedemptionRepository {
  /** Throws ConflictException when voucherId or idempotencyKey already exists. */
  create(record: RedemptionRecord): Promise<RedemptionRecord>;
  findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined>;
  find(criteria: RedemptionCriteria): Promise<RedemptionRecord[]>;
}

// ------------------------------------------------------------ in-memory

function matches<T>(record: T, expected: Partial<T>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (record[key as keyof T] !== value) {
      return false;
    }
  }
  return true;
}

export class InMemorySubsidyProgrammeRepository implements SubsidyProgrammeRepository {
  private readonly items = new Map<string, SubsidyProgrammeRecord>();

  async create(record: SubsidyProgrammeRecord): Promise<SubsidyProgrammeRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<SubsidyProgrammeRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: ProgrammeCriteria): Promise<SubsidyProgrammeRecord[]> {
    return [...this.items.values()]
      .filter((item) => !criteria.status || item.status === criteria.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<SubsidyProgrammeRecord>,
    expected: Partial<SubsidyProgrammeRecord>
  ): Promise<SubsidyProgrammeRecord> {
    const current = this.items.get(id);
    if (!current || !matches(current, expected)) {
      throw new ConflictException(`Programme '${id}' changed concurrently; reload and retry`);
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryBeneficiaryRepository implements BeneficiaryRepository {
  private readonly items = new Map<string, BeneficiaryRecord>();

  async create(record: BeneficiaryRecord): Promise<BeneficiaryRecord> {
    for (const existing of this.items.values()) {
      if (existing.programmeId === record.programmeId && existing.farmerId === record.farmerId) {
        throw new ConflictException('This farmer is already enrolled in the programme');
      }
      if (existing.programmeId === record.programmeId && existing.ninHash === record.ninHash) {
        throw new ConflictException('This NIN is already enrolled in the programme');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<BeneficiaryRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByProgrammeAndFarmer(
    programmeId: string,
    farmerId: string
  ): Promise<BeneficiaryRecord | undefined> {
    const record = [...this.items.values()].find(
      (item) => item.programmeId === programmeId && item.farmerId === farmerId
    );
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.programmeId || item.programmeId === criteria.programmeId) &&
          (!criteria.farmerId || item.farmerId === criteria.farmerId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export class InMemoryInputVoucherRepository implements InputVoucherRepository {
  private readonly items = new Map<string, InputVoucherRecord>();

  async create(record: InputVoucherRecord): Promise<InputVoucherRecord> {
    for (const existing of this.items.values()) {
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<InputVoucherRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<InputVoucherRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: InputVoucherCriteria): Promise<InputVoucherRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.programmeId || item.programmeId === criteria.programmeId) &&
          (!criteria.beneficiaryId || item.beneficiaryId === criteria.beneficiaryId) &&
          (!criteria.farmerId || item.farmerId === criteria.farmerId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<InputVoucherRecord>,
    expected: Partial<InputVoucherRecord>
  ): Promise<InputVoucherRecord> {
    const current = this.items.get(id);
    if (!current || !matches(current, expected)) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryRedemptionRepository implements RedemptionRepository {
  private readonly items = new Map<string, RedemptionRecord>();

  async create(record: RedemptionRecord): Promise<RedemptionRecord> {
    for (const existing of this.items.values()) {
      if (existing.voucherId === record.voucherId) {
        throw new ConflictException(`Voucher '${record.voucherId}' has already been redeemed`);
      }
      if (existing.idempotencyKey === record.idempotencyKey) {
        throw new ConflictException('A record with these unique values already exists');
      }
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: RedemptionCriteria): Promise<RedemptionRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.voucherId || item.voucherId === criteria.voucherId) &&
          (!criteria.programmeId || item.programmeId === criteria.programmeId) &&
          (!criteria.supplierId || item.supplierId === criteria.supplierId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => structuredClone(item));
  }
}

export function createInMemorySubsidyProgrammeRepository(): InMemorySubsidyProgrammeRepository {
  return new InMemorySubsidyProgrammeRepository();
}

export function createInMemoryBeneficiaryRepository(): InMemoryBeneficiaryRepository {
  return new InMemoryBeneficiaryRepository();
}

export function createInMemoryInputVoucherRepository(): InMemoryInputVoucherRepository {
  return new InMemoryInputVoucherRepository();
}

export function createInMemoryRedemptionRepository(): InMemoryRedemptionRepository {
  return new InMemoryRedemptionRepository();
}
