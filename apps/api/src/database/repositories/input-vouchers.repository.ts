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

/**
 * Funded-float backing state per programme (stage 23, audit C3 —
 * infra/postgres/046_voucher_programme_funding.sql). Invariant:
 * `reservedKobo + settledKobo <= fundedKobo` — outstanding plus settled face
 * value never exceeds actually-funded money.
 */
export interface ProgrammeFundingRecord {
  programmeId: string;
  /** Money actually topped up into the programme float. */
  fundedKobo: number;
  /** Face value reserved by live vouchers (ISSUED / pending states). */
  reservedKobo: number;
  /** Face value paid out on REDEEMED vouchers. */
  settledKobo: number;
  updatedAt: string;
}

export const FUNDING_EVENT_KINDS = ['top_up', 'settle', 'release'] as const;
export type FundingEventKind = (typeof FUNDING_EVENT_KINDS)[number];

export interface FundingEventRecord {
  id: string;
  programmeId: string;
  kind: FundingEventKind;
  amountKobo: number;
  /**
   * UNIQUE. top_up events carry the mandatory CLIENT idempotency key;
   * settle/release events carry the system marker
   * input-voucher-funding-{settle,release}:<voucherId> so a crash-resume or
   * concurrent retry applies the funding move exactly once per voucher.
   */
  idempotencyKey: string;
  reference?: string;
  createdBy: string;
  createdAt: string;
}

export interface FundingTopUpResult {
  event: FundingEventRecord;
  funding: ProgrammeFundingRecord;
  /** True when the idempotency key was already recorded — no double credit. */
  replayed: boolean;
}

/**
 * Opaque transaction handle scoped to
 * SubsidyProgrammeRepository.withAllocationLock (stage 24, audit A4-2). The
 * pg implementation passes the lock-transaction client so the conditional
 * reserve UPDATE and the voucher INSERT commit — or roll back — TOGETHER
 * with the programme row lock; the in-memory implementation passes nothing
 * (its reserve/create steps are already atomic under the promise mutex).
 */
export interface AllocationTx {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface ProgrammeFundingRepository {
  getFunding(programmeId: string): Promise<ProgrammeFundingRecord | undefined>;
  /**
   * Credits funded_kobo, idempotent on the event idempotency key: a replay
   * returns the original event WITHOUT double-crediting the float.
   */
  creditTopUp(event: FundingEventRecord): Promise<FundingTopUpResult>;
  /**
   * Atomic float reservation (audit C3): a single conditional UPDATE
   * (funded - reserved - settled >= amount); false means the float cannot
   * back the voucher and NOTHING may be issued. Pass the allocation-lock
   * `tx` (stage 24, audit A4-2) so the reservation commits/rolls back WITH
   * the voucher insert.
   */
  reserve(programmeId: string, amountKobo: number, tx?: AllocationTx): Promise<boolean>;
  /** Compensating release for a reservation whose voucher insert failed. */
  unreserve(programmeId: string, amountKobo: number): Promise<void>;
  /**
   * Exactly-once reserved → settled move, marker-keyed per voucher so
   * crash-resume replays never double-settle. No-op when the marker exists
   * or no reservation backs the voucher (legacy pre-046 vouchers).
   */
  settleReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void>;
  /**
   * Exactly-once reservation release on expire/void, marker-keyed per
   * voucher. Same no-op semantics as settleReserved.
   */
  releaseReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void>;
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
  withAllocationLock<T>(programmeId: string, fn: (tx?: AllocationTx) => Promise<T>): Promise<T>;
}

export interface BeneficiaryRepository {
  /** Throws ConflictException on duplicate (programmeId, farmerId) or (programmeId, ninHash). */
  create(record: BeneficiaryRecord): Promise<BeneficiaryRecord>;
  findById(id: string): Promise<BeneficiaryRecord | undefined>;
  findByProgrammeAndFarmer(
    programmeId: string,
    farmerId: string
  ): Promise<BeneficiaryRecord | undefined>;
  find(criteria: BeneficiaryCriteria): Promise<BeneficiaryRecord[]>;
}

export interface InputVoucherRepository {
  /**
   * Throws ConflictException when idempotencyKey already exists. Pass the
   * allocation-lock `tx` (stage 24, audit A4-2) so the insert commits/rolls
   * back WITH the float reservation.
   */
  create(record: InputVoucherRecord, tx?: AllocationTx): Promise<InputVoucherRecord>;
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

  async withAllocationLock<T>(programmeId: string, fn: (tx?: AllocationTx) => Promise<T>): Promise<T> {
    // Per-programme promise-chain mutex: mirrors the pg row lock so the
    // budget/cap check + insert serialise in tests exactly as in production.
    // No tx handle exists in memory (each awaited step is already atomic);
    // the callback receives `undefined` and compensates failures itself.
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

/**
 * In-memory funded-float store (stage 23, audit C3). Mirrors the pg
 * conditional UPDATEs: Node's single-threaded awaits make each method
 * atomic, and the event-key set mirrors the UNIQUE idempotency_key marker
 * that makes settle/release exactly-once per voucher.
 */
export class InMemoryProgrammeFundingRepository implements ProgrammeFundingRepository {
  private readonly funding = new Map<string, ProgrammeFundingRecord>();
  private readonly events = new Map<string, FundingEventRecord>();

  async getFunding(programmeId: string): Promise<ProgrammeFundingRecord | undefined> {
    const record = this.funding.get(programmeId);
    return record ? { ...record } : undefined;
  }

  async creditTopUp(event: FundingEventRecord): Promise<FundingTopUpResult> {
    const replay = this.events.get(event.idempotencyKey);
    if (replay) {
      // Stage 24 (audit A4-9): same key + different payload is a client bug
      // on a money endpoint — 409, never a silent replay.
      if (
        replay.programmeId !== event.programmeId ||
        replay.kind !== event.kind ||
        replay.amountKobo !== event.amountKobo
      ) {
        throw new ConflictException(
          `Idempotency key '${event.idempotencyKey}' was already used with a different funding payload`
        );
      }
      return {
        event: { ...replay },
        funding: { ...this.requireFunding(event.programmeId) },
        replayed: true
      };
    }
    const current = this.funding.get(event.programmeId) ?? {
      programmeId: event.programmeId,
      fundedKobo: 0,
      reservedKobo: 0,
      settledKobo: 0,
      updatedAt: event.createdAt
    };
    const updated: ProgrammeFundingRecord = {
      ...current,
      fundedKobo: current.fundedKobo + event.amountKobo,
      updatedAt: event.createdAt
    };
    this.funding.set(event.programmeId, updated);
    this.events.set(event.idempotencyKey, { ...event });
    return { event: { ...event }, funding: { ...updated }, replayed: false };
  }

  async reserve(programmeId: string, amountKobo: number): Promise<boolean> {
    const current = this.funding.get(programmeId);
    if (!current || current.fundedKobo - current.reservedKobo - current.settledKobo < amountKobo) {
      return false;
    }
    this.funding.set(programmeId, {
      ...current,
      reservedKobo: current.reservedKobo + amountKobo,
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  async unreserve(programmeId: string, amountKobo: number): Promise<void> {
    const current = this.funding.get(programmeId);
    if (!current || current.reservedKobo < amountKobo) {
      return;
    }
    this.funding.set(programmeId, {
      ...current,
      reservedKobo: current.reservedKobo - amountKobo,
      updatedAt: new Date().toISOString()
    });
  }

  async settleReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void> {
    this.applyMarker(programmeId, amountKobo, markerKey, actorId, 'settle');
  }

  async releaseReserved(programmeId: string, amountKobo: number, markerKey: string, actorId: string): Promise<void> {
    this.applyMarker(programmeId, amountKobo, markerKey, actorId, 'release');
  }

  private applyMarker(
    programmeId: string,
    amountKobo: number,
    markerKey: string,
    actorId: string,
    kind: 'settle' | 'release'
  ): void {
    if (this.events.has(markerKey)) {
      return; // exactly-once: the marker proves the move already happened
    }
    const current = this.funding.get(programmeId);
    // Stage 24 (audit A4-8): record the marker UNCONDITIONALLY, exactly like
    // the pg CTE (INSERT ... ON CONFLICT DO NOTHING). Recording it even when
    // the funding move no-ops (legacy/unbacked voucher) keeps a crash-resume
    // retry from moving ANOTHER voucher's reservation after unrelated
    // issuance raised reservedKobo >= amount.
    this.events.set(markerKey, {
      id: markerKey,
      programmeId,
      kind,
      amountKobo,
      idempotencyKey: markerKey,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    if (!current || current.reservedKobo < amountKobo) {
      return; // no backing reservation (legacy voucher) — fail closed, no negative float
    }
    this.funding.set(programmeId, {
      ...current,
      reservedKobo: current.reservedKobo - amountKobo,
      settledKobo: kind === 'settle' ? current.settledKobo + amountKobo : current.settledKobo,
      updatedAt: new Date().toISOString()
    });
  }

  private requireFunding(programmeId: string): ProgrammeFundingRecord {
    const record = this.funding.get(programmeId);
    if (!record) {
      throw new ConflictException(`Programme '${programmeId}' has no funding row`);
    }
    return record;
  }
}

export function createInMemoryProgrammeFundingRepository(): InMemoryProgrammeFundingRepository {
  return new InMemoryProgrammeFundingRepository();
}
