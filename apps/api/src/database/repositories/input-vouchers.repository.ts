import { ConflictException } from '@nestjs/common';

/**
 * Input-voucher persistence ports (wave NINVOUCHER). Rows map to the
 * input_vouchers schema (infra/postgres/035_input_vouchers.sql). These
 * tables hold OPERATIONAL records only — every value movement posts through
 * the double-entry ledger (finance module) and is cross-referenced by
 * `ledgerEntryId`. State machines advance via compare-and-set
 * (`updateExpected`) so concurrent transitions surface as 409 instead of
 * silently overwriting each other.
 */

export const PROGRAMME_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED'] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

// Pending states (stage 22, audit C1-6): the CAS into a pending state happens
// BEFORE the ledger posting so only the CAS winner ever posts — a redeem vs
// expire/void race can no longer double-debit the programme liability. A
// retry that finds a pending state resumes finalization instead of reposting.
export const INPUT_VOUCHER_STATUSES = [
  'ISSUED',
  'REDEEMING',
  'REDEEMED',
  'EXPIRING',
  'EXPIRED',
  'VOIDING',
  'VOIDED'
] as const;
export type InputVoucherStatus = (typeof INPUT_VOUCHER_STATUSES)[number];

export interface SubsidyProgrammeRecord {
  id: string;
  name: string;
  /** e.g. 'fertiliser' | 'seed' | 'agrochemical' — free-text category. */
  inputType: string;
  sponsorName: string;
  /** Total encumbered envelope in kobo (integers only). */
  budgetKobo: number;
  perFarmerCapKobo: number;
  status: ProgrammeStatus;
  /** Ledger liability account holding the encumbrance (programme:<id>:liability). */
  liabilityAccountCode: string;
  ledgerEntryId?: string;
  startsAt?: string;
  endsAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProgrammeCriteria {
  status?: ProgrammeStatus;
}

export interface BeneficiaryRecord {
  id: string;
  farmerId: string;
  programmeId: string;
  /** Salted HMAC-SHA256 of the NIN — dedupe key; the plaintext NIN is never stored. */
  ninHash: string;
  /** Last-3 mask for operator display (e.g. '***456'). */
  ninMask: string;
  verificationStatus: 'verified';
  /** 'stub' (deterministic dev driver) or 'live' (licensed vendor). */
  verificationBasis: 'stub' | 'live';
  verifiedAt: string;
  verifiedBy: string;
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
  /** UNIQUE — client idempotency key; transport retries replay, never duplicate. */
  idempotencyKey: string;
  expiresAt: string;
  distributedAt?: string;
  redeemedAt?: string;
  voidedAt?: string;
  ledgerEntryId?: string;
  createdAt: string;
}

export interface InputVoucherCriteria {
  programmeId?: string;
  farmerId?: string;
  status?: InputVoucherStatus;
}

export interface RedemptionRecord {
  id: string;
  voucherId: string;
  programmeId: string;
  supplierId: string;
  invoiceRef: string;
  amountKobo: number;
  idempotencyKey: string;
  ledgerEntryId: string;
  createdAt: string;
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
  /**
   * Serialises the callback per programme (stage 22, audit C2-10): the
   * budget/cap check + voucher insert inside the callback cannot interleave
   * with a concurrent allocation for the same programme. The pg
   * implementation holds a `SELECT ... FOR UPDATE` row lock on the programme
   * for the callback's duration; the in-memory implementation chains a
   * per-programme promise mutex (Node is single-threaded, so each awaited
   * step is atomic — the chain closes the check-then-act window).
   */
  withAllocationLock<T>(programmeId: string, fn: () => Promise<T>): Promise<T>;
}

export interface BeneficiaryRepository {
  create(record: BeneficiaryRecord): Promise<BeneficiaryRecord>;
  findById(id: string): Promise<BeneficiaryRecord | undefined>;
  find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]>;
  /** Dedupe lookup by (programmeId, ninHash). */
  findByProgrammeAndNinHash(
    programmeId: string,
    ninHash: string
  ): Promise<BeneficiaryRecord | undefined>;
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
  create(record: RedemptionRecord): Promise<RedemptionRecord>;
  findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined>;
  findByVoucherId(voucherId: string): Promise<RedemptionRecord | undefined>;
  findByProgrammeId(programmeId: string): Promise<RedemptionRecord[]>;
}

export class InMemorySubsidyProgrammeRepository implements SubsidyProgrammeRepository {
  private readonly items = new Map<string, SubsidyProgrammeRecord>();
  private readonly allocationLocks = new Map<string, Promise<unknown>>();

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
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<SubsidyProgrammeRecord>,
    expected: Partial<SubsidyProgrammeRecord>
  ): Promise<SubsidyProgrammeRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Programme '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof SubsidyProgrammeRecord] !== value) {
        throw new ConflictException(`Programme '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }

  async withAllocationLock<T>(programmeId: string, fn: () => Promise<T>): Promise<T> {
    // Per-programme promise-chain mutex: mirrors the pg row lock so the
    // budget/cap check + insert serialise in tests exactly as in production.
    const previous = this.allocationLocks.get(programmeId) ?? Promise.resolve();
    const run = previous.then(() => fn());
    this.allocationLocks.set(
      programmeId,
      run.catch(() => undefined)
    );
    return run;
  }
}

export class InMemoryBeneficiaryRepository implements BeneficiaryRepository {
  private readonly items = new Map<string, BeneficiaryRecord>();

  async create(record: BeneficiaryRecord): Promise<BeneficiaryRecord> {
    // Mirror the pg UNIQUE (programme_id, nin_hash): one enrolment per NIN
    // per programme.
    const clash = [...this.items.values()].find(
      (item) => item.programmeId === record.programmeId && item.ninHash === record.ninHash
    );
    if (clash) {
      throw new ConflictException('This NIN is already enrolled in the programme');
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<BeneficiaryRecord | undefined> {
    const record = this.items.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!criteria.programmeId || item.programmeId === criteria.programmeId) &&
          (!criteria.farmerId || item.farmerId === criteria.farmerId)
      )
      .map((item) => structuredClone(item));
  }

  async findByProgrammeAndNinHash(
    programmeId: string,
    ninHash: string
  ): Promise<BeneficiaryRecord | undefined> {
    const record = [...this.items.values()].find(
      (item) => item.programmeId === programmeId && item.ninHash === ninHash
    );
    return record ? structuredClone(record) : undefined;
  }
}

export class InMemoryInputVoucherRepository implements InputVoucherRepository {
  private readonly items = new Map<string, InputVoucherRecord>();

  async create(record: InputVoucherRecord): Promise<InputVoucherRecord> {
    const clash = [...this.items.values()].find(
      (item) => item.idempotencyKey === record.idempotencyKey
    );
    if (clash) {
      throw new ConflictException('A record with these unique values already exists');
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
          (!criteria.farmerId || item.farmerId === criteria.farmerId) &&
          (!criteria.status || item.status === criteria.status)
      )
      .map((item) => structuredClone(item));
  }

  async updateExpected(
    id: string,
    patch: Partial<InputVoucherRecord>,
    expected: Partial<InputVoucherRecord>
  ): Promise<InputVoucherRecord> {
    const current = this.items.get(id);
    if (!current) {
      throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
    }
    for (const [key, value] of Object.entries(expected)) {
      if (current[key as keyof InputVoucherRecord] !== value) {
        throw new ConflictException(`Voucher '${id}' changed concurrently; reload and retry`);
      }
    }
    const updated = { ...current, ...patch };
    this.items.set(id, updated);
    return structuredClone(updated);
  }
}

export class InMemoryRedemptionRepository implements RedemptionRepository {
  private readonly items = new Map<string, RedemptionRecord>();

  async create(record: RedemptionRecord): Promise<RedemptionRecord> {
    // Mirror the pg UNIQUE constraints on voucher_id and idempotency_key.
    const clash = [...this.items.values()].find(
      (item) => item.voucherId === record.voucherId || item.idempotencyKey === record.idempotencyKey
    );
    if (clash) {
      throw new ConflictException('A record with these unique values already exists');
    }
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findByIdempotencyKey(key: string): Promise<RedemptionRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.idempotencyKey === key);
    return record ? structuredClone(record) : undefined;
  }

  async findByVoucherId(voucherId: string): Promise<RedemptionRecord | undefined> {
    const record = [...this.items.values()].find((item) => item.voucherId === voucherId);
    return record ? structuredClone(record) : undefined;
  }

  async findByProgrammeId(programmeId: string): Promise<RedemptionRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.programmeId === programmeId)
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
