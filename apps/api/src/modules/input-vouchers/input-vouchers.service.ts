import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException
} from '@nestjs/common';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { newId } from '../../core/ids.js';
import {
  BENEFICIARY_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  NIN_VERIFICATION_PROVIDER,
  PROGRAMME_FUNDING_REPOSITORY,
  REDEMPTION_REPOSITORY,
  SUBSIDY_PROGRAMME_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  BeneficiaryRecord,
  BeneficiaryRepository,
  FundingTopUpResult,
  InputVoucherCriteria,
  InputVoucherRecord,
  InputVoucherRepository,
  InputVoucherStatus,
  ProgrammeCriteria,
  ProgrammeFundingRecord,
  ProgrammeFundingRepository,
  ProgrammeStatus,
  RedemptionCriteria,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from '../../database/repositories/input-vouchers.repository.js';
import type { UserRepository } from '../../database/repositories/user.repository.js';
import { USER_REPOSITORY } from '../../database/persistence.tokens.js';
import { LedgerService } from '../finance/ledger.service.js';
import type { NinVerificationProvider, NinVerificationResult } from './nin-verification.provider.js';

export const PLATFORM_SUBSIDY_BUDGET_ACCOUNT = 'platform:subsidy_budget';
export const DEFAULT_VOUCHER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Bounded-retry probe discipline for crash-safe rollback legs (stage 24,
 * audit A4-1): 3 attempts with 50–150ms jitter ride out the visibility
 * window between a twin's committed posting and our 23505.
 */
export const LEDGER_PROBE_ATTEMPTS = 3;
export const LEDGER_PROBE_BASE_DELAY_MS = 50;
export const LEDGER_PROBE_JITTER_MS = 101;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPositiveKobo(amountKobo: number, field = 'amountKobo'): void {
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    throw new BadRequestException(`${field} must be a positive integer kobo value`);
  }
}

export interface ActorRef {
  id: string;
  roles: readonly string[];
}

export interface CreateProgrammeInput {
  name: string;
  sponsor: string;
  description?: string;
  perFarmerCapKobo: number;
  budgetKobo: number;
  eligibleStates?: string[];
  eligibleCrops?: string[];
}

export interface EnrolBeneficiaryInput {
  farmerId: string;
  nin: string;
  state?: string;
  primaryCrop?: string;
}

export interface AllocateVoucherInput {
  farmerId: string;
  amountKobo: number;
  expiresAt?: string;
  /** Mandatory client idempotency key — allocation retries replay. */
  idempotencyKey: string;
}

export interface FundProgrammeInput {
  amountKobo: number;
  /** Mandatory client idempotency key (stage 23, audit C3) — top-up retries replay. */
  idempotencyKey: string;
  reference?: string;
}

export interface ProgrammeFundingView extends ProgrammeFundingRecord {
  /** funded - reserved - settled: the float that can back NEW vouchers. */
  availableKobo: number;
}

export interface VoucherReconciliation {
  programmeId: string;
  totals: {
    issuedCount: number;
    redeemedCount: number;
    expiredCount: number;
    voidedCount: number;
    outstandingCount: number;
    outstandingKobo: number;
    redeemedKobo: number;
  };
  ledger: {
    liabilityAccountCode: string;
    liabilityBalanceKobo: number;
    expectedLiabilityKobo: number;
    discrepancyKobo: number;
  };
  /** Funded-float view (stage 23, audit C3); absent when never funded. */
  funding?: ProgrammeFundingView;
}

export function supplierReceivableAccountCode(supplierId: string): string {
  return `supplier:${supplierId}:receivable`;
}

/**
 * Input-subsidy voucher service (wave NINVOUCHER). All value movement posts
 * through LedgerService against per-programme liability accounts:
 *   activation : CR programme:<id>:liability / DR platform:subsidy_budget
 *                (budget envelope earmarked as an outstanding obligation)
 *   redemption : DR programme liability / CR supplier:<id>:receivable
 *   expire/void: DR programme liability / CR platform:subsidy_budget
 * The vouchers table holds operational state only; money truth is the
 * ledger, and `reconciliation()` cross-checks outstanding face value against
 * the liability account balance. NIN handling goes through the
 * NinVerificationProvider port — only the hash + last-3 mask persist.
 *
 * Funded float (stage 23, audit C3): the budget envelope is a POLICY cap;
 * actual backing lives in programme_funding (funded/reserved/settled).
 * Allocation reserves funded money BEFORE signing — nothing issues against
 * unfunded budget (422) — and redeem/expire/void settle or release the
 * reservation exactly once via marker events.
 */
@Injectable()
export class InputVouchersService {
  constructor(
    @Inject(SUBSIDY_PROGRAMME_REPOSITORY) private readonly programmes: SubsidyProgrammeRepository,
    @Inject(BENEFICIARY_REPOSITORY) private readonly beneficiaries: BeneficiaryRepository,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly vouchers: InputVoucherRepository,
    @Inject(REDEMPTION_REPOSITORY) private readonly redemptions: RedemptionRepository,
    @Inject(PROGRAMME_FUNDING_REPOSITORY) private readonly funding: ProgrammeFundingRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(NIN_VERIFICATION_PROVIDER) private readonly ninProvider: NinVerificationProvider,
    private readonly ledger: LedgerService,
    private readonly events: DomainEventsService,
    @Optional() private readonly audit?: AuditService
  ) {}

  // ------------------------------------------------------------- programmes

  async createProgramme(input: CreateProgrammeInput, actorId: string): Promise<SubsidyProgrammeRecord> {
    assertPositiveKobo(input.perFarmerCapKobo, 'perFarmerCapKobo');
    assertPositiveKobo(input.budgetKobo, 'budgetKobo');
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!input.sponsor?.trim()) {
      throw new BadRequestException('sponsor is required');
    }
    const now = new Date().toISOString();
    const record = await this.programmes.create({
      id: newId('ivp'),
      name: input.name.trim(),
      sponsor: input.sponsor.trim(),
      description: input.description?.trim() || undefined,
      status: 'DRAFT',
      perFarmerCapKobo: input.perFarmerCapKobo,
      budgetKobo: input.budgetKobo,
      eligibleStates: input.eligibleStates ?? [],
      eligibleCrops: input.eligibleCrops ?? [],
      liabilityAccountCode: '',
      createdBy: actorId,
      createdAt: now,
      updatedAt: now
    });
    const liabilityAccountCode = `programme:${record.id}:liability`;
    await this.ledger.ensureAccount({ code: liabilityAccountCode, type: 'liability' });
    return this.programmes.updateExpected(record.id, { liabilityAccountCode }, { status: 'DRAFT' });
  }

  async getProgramme(id: string): Promise<SubsidyProgrammeRecord> {
    const programme = await this.programmes.findById(id);
    if (!programme) {
      throw new NotFoundException(`Programme '${id}' not found`);
    }
    return programme;
  }

  async listProgrammes(criteria: ProgrammeCriteria): Promise<SubsidyProgrammeRecord[]> {
    return this.programmes.find(criteria);
  }

  /**
   * DRAFT→ACTIVE: earmarks the budget envelope in the ledger (CR liability /
   * DR platform subsidy budget, idempotent on programme-activation:<id>).
   * ACTIVE→CLOSED refuses while any voucher is outstanding.
   */
  async setProgrammeStatus(id: string, status: ProgrammeStatus, actorId: string): Promise<SubsidyProgrammeRecord> {
    const programme = await this.getProgramme(id);
    if (programme.status === status) {
      return programme; // idempotent replay
    }
    const allowed: Record<ProgrammeStatus, ProgrammeStatus[]> = {
      DRAFT: ['ACTIVE'],
      ACTIVE: ['CLOSED'],
      CLOSED: []
    };
    if (!allowed[programme.status].includes(status)) {
      throw new BadRequestException(`Programme status cannot move from ${programme.status} to ${status}`);
    }
    if (status === 'CLOSED') {
      const outstanding = await this.vouchers.find({ programmeId: id, status: 'ISSUED' });
      if (outstanding.length > 0) {
        throw new ConflictException(
          `Programme has ${outstanding.length} outstanding voucher(s); let them expire or void them first`
        );
      }
    }
    const updated = await this.programmes.updateExpected(
      id,
      { status, updatedAt: new Date().toISOString() },
      { status: programme.status }
    );
    if (status === 'ACTIVE') {
      await this.ledger.ensureAccount({ code: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, type: 'expense' });
      await this.ledger.postEntry(
        {
          idempotencyKey: `programme-activation:${id}`,
          referenceType: 'input_voucher_programme_activation',
          referenceId: id,
          description: `Budget envelope activation for programme ${id}`,
          postings: [
            { accountCode: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, direction: 'debit', amountKobo: programme.budgetKobo },
            { accountCode: programme.liabilityAccountCode, direction: 'credit', amountKobo: programme.budgetKobo }
          ]
        },
        actorId
      );
      await this.events.publish(
        'inputvouchers.programme.activated',
        { programmeId: id, budgetKobo: programme.budgetKobo },
        actorId
      );
    }
    if (status === 'CLOSED') {
      await this.events.publish('inputvouchers.programme.closed', { programmeId: id }, actorId);
    }
    return updated;
  }

  // ------------------------------------------------------------ beneficiary

  /**
   * Enrols a farmer: verifies the NIN through the provider port (stub or
   * live), then persists ONLY the salted hash + last-3 mask. Duplicate
   * farmer or duplicate NIN within the programme is a 409.
   */
  async enrolBeneficiary(
    programmeId: string,
    input: EnrolBeneficiaryInput,
    actorId: string
  ): Promise<BeneficiaryRecord> {
    const programme = await this.getProgramme(programmeId);
    if (programme.status !== 'ACTIVE') {
      throw new BadRequestException(`Enrolment requires an ACTIVE programme (status is ${programme.status})`);
    }
    await this.users.getById(input.farmerId);
    const verification = await this.ninProvider.verify(input.nin, input.farmerId);
    this.assertEligibility(programme, verification, input);
    try {
      const record = await this.beneficiaries.create({
        id: newId('ivb'),
        programmeId,
        farmerId: input.farmerId,
        ninHash: verification.ninHash,
        ninMask: verification.ninMask,
        verificationBasis: verification.basis,
        nameMatchScore: verification.nameMatchScore,
        state: input.state,
        primaryCrop: input.primaryCrop,
        verifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });
      await this.events.publish(
        'inputvouchers.beneficiary.enrolled',
        { beneficiaryId: record.id, programmeId, farmerId: input.farmerId, verificationBasis: verification.basis },
        actorId
      );
      await this.audit?.record({
        actorId,
        action: 'inputvouchers.beneficiary.enrolled',
        entityType: 'input_vouchers_beneficiaries',
        entityId: record.id,
        metadata: { programmeId, farmerId: input.farmerId, ninMask: verification.ninMask, basis: verification.basis }
      });
      return record;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Lost a duplicate-enrolment race — the first enrolment is
        // authoritative; re-throw so the caller sees the conflict (no
        // silent second beneficiary row for the same farmer or NIN).
        throw error;
      }
      throw error;
    }
  }

  async getBeneficiary(id: string): Promise<BeneficiaryRecord> {
    const beneficiary = await this.beneficiaries.findById(id);
    if (!beneficiary) {
      throw new NotFoundException(`Beneficiary '${id}' not found`);
    }
    return beneficiary;
  }

  async listBeneficiaries(programmeId: string): Promise<BeneficiaryRecord[]> {
    return this.beneficiaries.find({ programmeId });
  }

  private assertEligibility(
    programme: SubsidyProgrammeRecord,
    verification: NinVerificationResult,
    input: EnrolBeneficiaryInput
  ): void {
    if (!verification.verified) {
      throw new UnprocessableEntityException('NIN verification failed');
    }
    const state = input.state ?? verification.state;
    if (programme.eligibleStates.length > 0 && (!state || !programme.eligibleStates.includes(state))) {
      throw new UnprocessableEntityException(`State '${state ?? 'unknown'}' is not eligible for this programme`);
    }
    const crop = input.primaryCrop ?? verification.primaryCrop;
    if (programme.eligibleCrops.length > 0 && (!crop || !programme.eligibleCrops.includes(crop))) {
      throw new UnprocessableEntityException(`Crop '${crop ?? 'unknown'}' is not eligible for this programme`);
    }
  }

  // --------------------------------------------------------------- vouchers

  /**
   * Allocates a voucher against an ACTIVE programme. Enforces the
   * per-farmer cap and the budget envelope against ISSUED face value, then
   * signs nothing — the voucher is bearer-scoped to the beneficiary farmer
   * and redeemed by invoice reference at an agro-dealer. Idempotent on the
   * caller-supplied key.
   *
   * Race discipline (stage 22, audit C2-10): the budget/cap check + insert
   * run inside withAllocationLock, so concurrent allocations for one
   * programme serialise — two allocations cannot both pass the budget check
   * and overshoot the envelope.
   */
  async allocateVoucher(
    programmeId: string,
    input: AllocateVoucherInput,
    actorId: string
  ): Promise<InputVoucherRecord> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — allocation must be replay-safe');
    }
    assertPositiveKobo(input.amountKobo);
    const replay = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      this.assertAllocationReplayMatches(replay, programmeId, input);
      return replay; // idempotent replay of a transport retry
    }
    const programme = await this.getProgramme(programmeId);
    if (programme.status !== 'ACTIVE') {
      throw new BadRequestException(`Allocation requires an ACTIVE programme (status is ${programme.status})`);
    }
    const beneficiary = await this.beneficiaries.findByProgrammeAndFarmer(programmeId, input.farmerId);
    if (!beneficiary) {
      throw new UnprocessableEntityException('Farmer is not an enrolled beneficiary of this programme');
    }
    const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_VOUCHER_TTL_MS).toISOString();
    if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new BadRequestException('expiresAt must be a future ISO-8601 timestamp');
    }
    const record = await this.programmes.withAllocationLock(programmeId, async (tx) => {
      // Re-check the idempotency key INSIDE the lock: a twin request may
      // have committed while this one waited on the programme row — replay
      // it here so we never reserve the float twice for one voucher.
      const twin = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
      if (twin) {
        this.assertAllocationReplayMatches(twin, programmeId, input);
        return twin;
      }
      // Policy envelope: per-farmer cap and programme budget against the
      // outstanding ISSUED face value (the liability the programme would
      // owe if every outstanding voucher were redeemed today).
      const outstanding = await this.vouchers.find({ programmeId, status: 'ISSUED' });
      const farmerUsed = outstanding
        .filter((voucher) => voucher.farmerId === input.farmerId)
        .reduce((sum, voucher) => sum + voucher.amountKobo, 0);
      if (farmerUsed + input.amountKobo > programme.perFarmerCapKobo) {
        throw new UnprocessableEntityException(
          `Per-farmer cap exceeded: ${farmerUsed + input.amountKobo} kobo would exceed ${programme.perFarmerCapKobo}`
        );
      }
      const programmeUsed = outstanding.reduce((sum, voucher) => sum + voucher.amountKobo, 0);
      if (programmeUsed + input.amountKobo > programme.budgetKobo) {
        throw new BadRequestException(
          `Programme budget exceeded: ${programmeUsed + input.amountKobo} kobo would exceed the ${programme.budgetKobo} kobo envelope`
        );
      }
      // Funded-float backing (stage 23, audit C3): reserve the face value
      // against actually-funded money BEFORE anything is signed. The
      // conditional UPDATE moves 0 rows when the float cannot back the
      // voucher ⇒ 422 and NOTHING is persisted. Stage 24 (audit A4-2): the
      // reserve and the voucher insert run in the allocation-lock
      // transaction (`tx`) on pg, so they commit together or roll back
      // together — a mid-flight failure can no longer strand a reservation
      // OR free the backing of a committed voucher.
      const reserved = await this.funding.reserve(programmeId, input.amountKobo, tx);
      if (!reserved) {
        throw new UnprocessableEntityException(
          `Insufficient programme funding: the funded float cannot back another ${input.amountKobo} kobo voucher`
        );
      }
      try {
        return await this.vouchers.create(
          {
            id: newId('ivc'),
            programmeId,
            beneficiaryId: beneficiary.id,
            farmerId: input.farmerId,
            amountKobo: input.amountKobo,
            status: 'ISSUED',
            idempotencyKey: input.idempotencyKey,
            expiresAt,
            createdAt: new Date().toISOString()
          },
          tx
        );
      } catch (error) {
        if (error instanceof ConflictException) {
          // Lost a retry race — the original record is authoritative.
          const existing = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
          if (existing) {
            this.assertAllocationReplayMatches(existing, programmeId, input);
            return existing;
          }
        }
        // Issuance failed after the reservation. Audit A4-2: NEVER unreserve
        // when the voucher row actually committed under our key — that would
        // free the backing of a LIVE voucher. On pg the lock transaction
        // rolls the reservation back with the failed insert (no compensation
        // needed — and running unreserve on the pool here would decrement
        // OTHER vouchers' reservations); in-memory compensates explicitly.
        if (!tx) {
          const committed = await this.vouchers
            .findByIdempotencyKey(input.idempotencyKey)
            .catch(() => undefined);
          if (!committed) {
            await this.funding.unreserve(programmeId, input.amountKobo).catch(() => undefined);
          }
        }
        throw error;
      }
    });
    // Post-commit side effects (audit A4-2): publish/audit run AFTER the
    // reservation+voucher transaction committed, so a failure here can never
    // trigger the unreserve of a live voucher's backing; a client retry with
    // the same idempotency key replays the committed voucher above.
    await this.events.publish(
      'inputvouchers.voucher.allocated',
      { voucherId: record.id, programmeId, farmerId: input.farmerId, amountKobo: input.amountKobo },
      actorId
    );
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.voucher.allocated',
      entityType: 'input_vouchers_vouchers',
      entityId: record.id,
      metadata: { programmeId, farmerId: input.farmerId, amountKobo: input.amountKobo }
    });
    return record;
  }

  /**
   * Replay doctrine (stage 24, audit A4-9): the same allocation idempotency
   * key with a DIFFERENT payload is a client bug on a money endpoint — 409,
   * never a silent replay of the original voucher (mirrors the payout rail's
   * payload-hash check and the savings replay 409).
   */
  private assertAllocationReplayMatches(
    record: InputVoucherRecord,
    programmeId: string,
    input: AllocateVoucherInput
  ): void {
    const mismatches: string[] = [];
    if (record.programmeId !== programmeId) {
      mismatches.push('programmeId');
    }
    if (record.farmerId !== input.farmerId) {
      mismatches.push('farmerId');
    }
    if (record.amountKobo !== input.amountKobo) {
      mismatches.push('amountKobo');
    }
    if (input.expiresAt && Date.parse(record.expiresAt) !== Date.parse(input.expiresAt)) {
      mismatches.push('expiresAt');
    }
    if (mismatches.length > 0) {
      throw new ConflictException(
        `Idempotency key '${input.idempotencyKey}' was already used with a different allocation payload (${mismatches.join(', ')})`
      );
    }
  }

  /**
   * Tops up the programme float (stage 23, audit C3). The top-up is a
   * funding EVENT with a mandatory idempotency key — a replay returns the
   * original event and NEVER double-credits. The money itself enters the
   * ledger through the sponsor funding posting (DR platform:subsidy_budget
   * source of truth stays the budget expense account; CR programme float
   * liability), so the float cannot be conjured without a ledger trail.
   */
  async fundProgramme(
    programmeId: string,
    input: FundProgrammeInput,
    actorId: string
  ): Promise<FundingTopUpResult> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — funding must be replay-safe');
    }
    assertPositiveKobo(input.amountKobo);
    const programme = await this.getProgramme(programmeId);
    await this.ledger.ensureAccount({ code: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, type: 'expense' });
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-funding:${input.idempotencyKey}`,
        referenceType: 'input_voucher_programme_funding',
        referenceId: programmeId,
        description: `Programme float top-up for ${programmeId}`,
        postings: [
          { accountCode: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, direction: 'debit', amountKobo: input.amountKobo },
          { accountCode: programme.liabilityAccountCode, direction: 'credit', amountKobo: input.amountKobo }
        ]
      },
      actorId
    );
    const result = await this.funding.creditTopUp({
      id: newId('ivf'),
      programmeId,
      kind: 'top_up',
      amountKobo: input.amountKobo,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    if (!result.replayed) {
      await this.events.publish(
        'inputvouchers.programme.funded',
        { programmeId, amountKobo: input.amountKobo, fundedKobo: result.funding.fundedKobo, ledgerEntryId: entry.id },
        actorId
      );
    }
    return result;
  }

  /** Funded-float view for one programme (404 when the programme is unknown). */
  async getProgrammeFunding(programmeId: string): Promise<ProgrammeFundingView> {
    await this.getProgramme(programmeId);
    const funding = await this.funding.getFunding(programmeId);
    const record: ProgrammeFundingRecord =
      funding ?? { programmeId, fundedKobo: 0, reservedKobo: 0, settledKobo: 0, updatedAt: '' };
    return {
      ...record,
      availableKobo: record.fundedKobo - record.reservedKobo - record.settledKobo
    };
  }

  async getVoucher(id: string): Promise<InputVoucherRecord> {
    const voucher = await this.vouchers.findById(id);
    if (!voucher) {
      throw new NotFoundException(`Voucher '${id}' not found`);
    }
    return voucher;
  }

  async listVouchers(criteria: InputVoucherCriteria): Promise<InputVoucherRecord[]> {
    return this.vouchers.find(criteria);
  }

  /**
   * Marks the voucher as handed to the farmer (ISSUED stays the money
   * state; distribution is an audit breadcrumb, not a state transition).
   */
  async distributeVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    const voucher = await this.getVoucher(id);
    if (voucher.status !== 'ISSUED') {
      throw new ConflictException(`Only ISSUED vouchers can be distributed (status is ${voucher.status})`);
    }
    if (voucher.distributedAt) {
      return voucher; // idempotent replay
    }
    const updated = await this.vouchers.updateExpected(
      id,
      { distributedAt: new Date().toISOString() },
      { status: 'ISSUED' }
    );
    await this.events.publish('inputvouchers.voucher.distributed', { voucherId: id }, actorId);
    return updated;
  }

  /**
   * Redeems a voucher at an agro-dealer: the supplier presents the voucher
   * id plus an invoice reference. Settles DR programme liability / CR
   * supplier receivable and CASes REDEEMING→REDEEMED; the redemptions table
   * UNIQUE(voucher_id) is the hard anti-double-spend backstop. Idempotent
   * on input-voucher-redemption:<id>.
   *
   * Race discipline (stage 22, audit C1-6): the voucher CASes
   * ISSUED→REDEEMING BEFORE the ledger posting, so a concurrent expire/void
   * loses its own CAS into EXPIRING/VOIDING and cannot double-debit the
   * programme liability. A retry that finds REDEEMING resumes: the ledger
   * posting stays idempotent on input-voucher-redemption:<id>; a retry that
   * finds REDEEMING with the redemption row already present completes
   * finalization instead of reposting (replay returns the settled view). On
   * posting failure the claim rolls back REDEEMING→ISSUED ONLY when the
   * ledger proves no redemption entry exists (stage 24, audit A4-1/A1-3) —
   * otherwise REDEEMING stays for the resume path and the caller gets 409.
   */
  async redeemVoucher(
    id: string,
    invoiceRef: string,
    actor: ActorRef
  ): Promise<{ voucher: InputVoucherRecord; redemption: RedemptionRecord }> {
    if (!invoiceRef?.trim()) {
      throw new BadRequestException('invoiceRef is required');
    }
    if (!actor.roles.includes('supplier') && !actor.roles.includes('admin')) {
      throw new ForbiddenException('Only a supplier or admin can redeem vouchers');
    }
    let voucher = await this.getVoucher(id);
    if (voucher.status === 'REDEEMED') {
      throw new ConflictException(`Voucher '${id}' has already been redeemed`);
    }
    if (voucher.status === 'VOIDED' || voucher.status === 'EXPIRED') {
      throw new ConflictException(`Voucher '${id}' is ${voucher.status.toLowerCase()} and cannot be redeemed`);
    }
    if (voucher.status === 'ISSUED' && Date.parse(voucher.expiresAt) <= Date.now()) {
      // Past TTL: expire (with the same release posting) instead of paying.
      await this.expireIssuedVoucher(voucher, actor.id);
      throw new GoneException('Voucher has expired');
    }
    const programme = await this.getProgramme(voucher.programmeId);
    if (voucher.status === 'ISSUED') {
      voucher = await this.vouchers.updateExpected(id, { status: 'REDEEMING' }, { status: 'ISSUED' });
    }
    const redemptionKey = `input-voucher-redemption:${voucher.id}`;
    let redemption = await this.redemptions.findByIdempotencyKey(redemptionKey);
    if (!redemption) {
      try {
        const supplierAccount = supplierReceivableAccountCode(actor.id);
        await this.ledger.ensureAccount({ code: supplierAccount, type: 'liability', ownerId: actor.id });
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: redemptionKey,
            referenceType: 'input_voucher_redemption',
            referenceId: voucher.id,
            description: `Input voucher redemption ${voucher.id} (invoice ${invoiceRef.trim()})`,
            postings: [
              { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo: voucher.amountKobo },
              { accountCode: supplierAccount, direction: 'credit', amountKobo: voucher.amountKobo }
            ]
          },
          actor.id
        );
        redemption = await this.redemptions.create({
          id: newId('ivr'),
          voucherId: voucher.id,
          programmeId: voucher.programmeId,
          supplierId: actor.id,
          invoiceRef: invoiceRef.trim(),
          amountKobo: voucher.amountKobo,
          idempotencyKey: redemptionKey,
          ledgerEntryId: entry.id,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        if (error instanceof ConflictException) {
          // A twin request created the redemption row first (UNIQUE
          // voucher_id) — adopt its record instead of double-settling.
          // Bounded-retry probe (stage 24, audit A4-1): the twin's row can
          // commit a beat AFTER its ledger posting already 23505'd us, so a
          // single lookup would miss and fall into the rollback leg below.
          redemption = await this.probeRedemptionRow(redemptionKey);
        }
        if (!redemption) {
          // Stage 24 (audit A4-1/A1-3): the claim may roll back to ISSUED
          // ONLY when the ledger PROVES no redemption entry exists under
          // this operation's key — otherwise a later void/expire would
          // debit the liability a SECOND time on top of the committed
          // posting. When the entry exists (or the probe is inconclusive)
          // the claim stays REDEEMING for the resume path and the caller
          // gets a 409.
          return await this.rollbackClaimIfUnposted(id, 'REDEEMING', redemptionKey, error);
        }
      }
    }
    // The reservation moves reserved → settled exactly once (stage 23,
    // audit C3) — the marker is keyed on the voucher, so a resume after a
    // crash between posting and settlement cannot double-settle.
    await this.funding.settleReserved(
      voucher.programmeId,
      voucher.amountKobo,
      `input-voucher-funding-settle:${voucher.id}`,
      actor.id
    );
    const redeemed = await this.vouchers.updateExpected(
      id,
      { status: 'REDEEMED', redeemedAt: new Date().toISOString(), ledgerEntryId: redemption.ledgerEntryId },
      { status: 'REDEEMING' }
    );
    await this.events.publish(
      'inputvouchers.voucher.redeemed',
      { voucherId: id, programmeId: voucher.programmeId, supplierId: redemption.supplierId, amountKobo: redemption.amountKobo },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'inputvouchers.voucher.redeemed',
      entityType: 'input_vouchers_vouchers',
      entityId: id,
      metadata: { programmeId: voucher.programmeId, supplierId: redemption.supplierId, amountKobo: redemption.amountKobo }
    });
    return { voucher: redeemed, redemption };
  }

  /**
   * Expires an ISSUED voucher past its TTL (also callable explicitly by an
   * admin). Releases the encumbrance: DR programme liability / CR platform
   * subsidy budget, then CASes EXPIRING→EXPIRED. The release posting is
   * idempotent on input-voucher-release:<id>, so a retry that finds EXPIRING
   * resumes finalization instead of double-releasing; on posting failure the
   * claim rolls back EXPIRING→ISSUED only with proof that no release entry
   * exists (stage 24, audit A4-1) — otherwise EXPIRING stays for resume.
   */
  async expireVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    let voucher = await this.getVoucher(id);
    if (voucher.status === 'EXPIRED') {
      return voucher; // idempotent replay
    }
    if (voucher.status !== 'ISSUED' && voucher.status !== 'EXPIRING') {
      throw new ConflictException(`Only ISSUED vouchers can expire (status is ${voucher.status})`);
    }
    if (voucher.status === 'ISSUED' && Date.parse(voucher.expiresAt) > Date.now()) {
      throw new BadRequestException('Voucher has not reached its expiry timestamp');
    }
    voucher = await this.expireIssuedVoucher(voucher, actorId);
    return voucher;
  }

  private async expireIssuedVoucher(voucher: InputVoucherRecord, actorId: string): Promise<InputVoucherRecord> {
    // Stage 24 (audit A1-3): never release on top of a committed redemption
    // posting — that debits the liability twice.
    await this.assertNoRedemptionPosting(voucher);
    if (voucher.status === 'ISSUED') {
      await this.vouchers.updateExpected(voucher.id, { status: 'EXPIRING' }, { status: 'ISSUED' });
    }
    try {
      await this.releaseEncumbrance(voucher, actorId, 'expiry');
      // Release the float reservation exactly once (stage 23, audit C3) —
      // marker-keyed so a retry resuming EXPIRING never double-releases.
      await this.funding.releaseReserved(
        voucher.programmeId,
        voucher.amountKobo,
        `input-voucher-funding-release:${voucher.id}`,
        actorId
      );
    } catch (error) {
      // Stage 24 (audit A4-1): roll back ONLY with proof that no release
      // entry exists; otherwise leave EXPIRING for resume and surface 409.
      await this.rollbackClaimIfUnposted(
        voucher.id,
        'EXPIRING',
        `input-voucher-release:${voucher.id}`,
        error
      );
    }
    const expired = await this.vouchers.updateExpected(
      voucher.id,
      { status: 'EXPIRED' },
      { status: 'EXPIRING' }
    );
    await this.events.publish('inputvouchers.voucher.expired', { voucherId: voucher.id }, actorId);
    return expired;
  }

  /**
   * Voids an ISSUED voucher (admin): releases the encumbrance exactly like
   * expiry but lands on VOIDED. Refuses REDEEMING/REDEEMED — a voucher in
   * the redemption pipeline can never be voided out from under the ledger.
   */
  async voidVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    let voucher = await this.getVoucher(id);
    if (voucher.status !== 'ISSUED' && voucher.status !== 'VOIDING') {
      throw new ConflictException(`Only ISSUED vouchers can be voided (status is ${voucher.status})`);
    }
    // Stage 24 (audit A1-3): never release the encumbrance of a voucher whose
    // REDEMPTION posting already committed — that would debit the liability
    // twice (supplier paid AND budget re-credited).
    await this.assertNoRedemptionPosting(voucher);
    if (voucher.status === 'ISSUED') {
      voucher = await this.vouchers.updateExpected(id, { status: 'VOIDING' }, { status: 'ISSUED' });
    }
    try {
      await this.releaseEncumbrance(voucher, actorId, 'void');
      // Release the float reservation exactly once (stage 23, audit C3) —
      // marker-keyed so a retry resuming VOIDING never double-releases.
      await this.funding.releaseReserved(
        voucher.programmeId,
        voucher.amountKobo,
        `input-voucher-funding-release:${voucher.id}`,
        actorId
      );
    } catch (error) {
      // Stage 24 (audit A4-1): roll the claim back ONLY when the ledger
      // proves no release entry exists under input-voucher-release:<id>;
      // a racing twin's committed posting (23505) must leave VOIDING in
      // place for resume, surfacing 409 — never re-open the voucher.
      await this.rollbackClaimIfUnposted(id, 'VOIDING', `input-voucher-release:${voucher.id}`, error);
    }
    const voided = await this.vouchers.updateExpected(
      id,
      { status: 'VOIDED', voidedAt: new Date().toISOString() },
      { status: 'VOIDING' }
    );
    await this.events.publish('inputvouchers.voucher.voided', { voucherId: id }, actorId);
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.voucher.voided',
      entityType: 'input_vouchers_vouchers',
      entityId: id,
      metadata: { programmeId: voucher.programmeId }
    });
    return voided;
  }

  async listRedemptions(criteria: RedemptionCriteria): Promise<RedemptionRecord[]> {
    return this.redemptions.find(criteria);
  }

  /** Releases the encumbrance: DR programme liability / CR platform budget expense. */
  private async releaseEncumbrance(
    voucher: InputVoucherRecord,
    actorId: string,
    reason: 'void' | 'expiry'
  ): Promise<void> {
    const programme = await this.getProgramme(voucher.programmeId);
    await this.ledger.ensureAccount({ code: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, type: 'expense' });
    await this.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-release:${voucher.id}`,
        referenceType: `input_voucher_${reason}_release`,
        referenceId: voucher.id,
        description: `Subsidy encumbrance release (${reason}) for voucher ${voucher.id}`,
        postings: [
          { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo: voucher.amountKobo },
          { accountCode: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, direction: 'credit', amountKobo: voucher.amountKobo }
        ]
      },
      actorId
    );
  }

  // ------------------------------------------- crash-safe claim discipline

  /**
   * Bounded-retry ledger truth probe (stage 24, audit A4-1/A1-3). A racing
   * twin's commit can become visible a beat AFTER its 23505 reached us, so
   * one lookup is not proof of absence. Returns:
   *  - 'found'   — an entry exists under the key (twin committed / our own
   *                posting actually landed despite the error);
   *  - 'absent'  — every probe succeeded and found nothing: PROOF no entry
   *                exists, the only state in which a claim may roll back;
   *  - 'unknown' — the probe itself could not complete; callers must treat
   *                this like 'found' (when in doubt, leave the pending state
   *                for resume and surface 409).
   */
  private async probeLedgerEntry(key: string): Promise<{ state: 'found' | 'absent' | 'unknown' }> {
    let sawFailure = false;
    for (let attempt = 0; attempt < LEDGER_PROBE_ATTEMPTS; attempt += 1) {
      try {
        if (await this.ledger.findEntryByIdempotencyKey(key)) {
          return { state: 'found' };
        }
      } catch {
        sawFailure = true; // the probe itself failed — we know nothing
      }
      if (attempt < LEDGER_PROBE_ATTEMPTS - 1) {
        await sleep(LEDGER_PROBE_BASE_DELAY_MS + Math.floor(Math.random() * LEDGER_PROBE_JITTER_MS));
      }
    }
    return { state: sawFailure ? 'unknown' : 'absent' };
  }

  /**
   * Bounded-retry adoption probe for the redemption row: a twin that beat us
   * to the ledger insert (23505) writes its redemption row a beat later, so
   * the single-shot lookup used previously could miss and drop into the
   * rollback leg while the twin's posting stood (audit A4-1).
   */
  private async probeRedemptionRow(key: string): Promise<RedemptionRecord | undefined> {
    for (let attempt = 0; attempt < LEDGER_PROBE_ATTEMPTS; attempt += 1) {
      try {
        const row = await this.redemptions.findByIdempotencyKey(key);
        if (row) {
          return row;
        }
      } catch {
        // lookup hiccup — retry within the bound
      }
      if (attempt < LEDGER_PROBE_ATTEMPTS - 1) {
        await sleep(LEDGER_PROBE_BASE_DELAY_MS + Math.floor(Math.random() * LEDGER_PROBE_JITTER_MS));
      }
    }
    return undefined;
  }

  /**
   * Crash-safe claim rollback (stage 24, audit A4-1/A1-3): a failed posting
   * leg may roll the pending claim (REDEEMING/EXPIRING/VOIDING) back to
   * ISSUED ONLY when the ledger PROVES no entry exists under the operation's
   * idempotency key. Rolling back while a twin's (or our own) posting stands
   * re-opens the voucher to the OTHER spending path and double-debits the
   * programme liability. When the entry exists or the probe is inconclusive
   * the claim stays pending — the next call resumes it — and the caller
   * surfaces a 409 instead of a re-opened voucher.
   */
  private async rollbackClaimIfUnposted(
    voucherId: string,
    pending: 'REDEEMING' | 'EXPIRING' | 'VOIDING',
    ledgerKey: string,
    error: unknown
  ): Promise<never> {
    const probe = await this.probeLedgerEntry(ledgerKey);
    if (probe.state === 'absent') {
      // Proven: nothing posted under this key — safe to re-open for retry.
      await this.vouchers
        .updateExpected(voucherId, { status: 'ISSUED' }, { status: pending })
        .catch(() => undefined);
      throw error;
    }
    throw new ConflictException(
      `Voucher '${voucherId}' ${pending.toLowerCase()} posting state is uncertain — the claim stays ${pending} for a safe resume; retry the operation`
    );
  }

  /**
   * Refuses to release the encumbrance of a voucher whose REDEMPTION posting
   * already exists in the ledger (stage 24, audit A1-3): releasing on top of
   * it debits the programme liability twice (supplier paid AND budget
   * re-credited). A stale pending claim (VOIDING/EXPIRING left by the old
   * rollback leg) is handed back to ISSUED only when the RELEASE posting is
   * proven absent, so the redemption resume path can settle the voucher
   * exactly once.
   */
  private async assertNoRedemptionPosting(voucher: InputVoucherRecord): Promise<void> {
    const redemption = await this.probeLedgerEntry(`input-voucher-redemption:${voucher.id}`);
    if (redemption.state !== 'found') {
      return;
    }
    if (voucher.status === 'VOIDING' || voucher.status === 'EXPIRING') {
      const release = await this.probeLedgerEntry(`input-voucher-release:${voucher.id}`);
      if (release.state === 'absent') {
        await this.vouchers
          .updateExpected(voucher.id, { status: 'ISSUED' }, { status: voucher.status })
          .catch(() => undefined);
      }
    }
    throw new ConflictException(
      `Voucher '${voucher.id}' already has a redemption posting in the ledger — it cannot be released; a redeem retry settles it`
    );
  }

  /**
   * Cross-checks the operational tables against the ledger liability:
   * expected liability = budget - redeemed - expired-released - voided
   * (tracked via redemption rows vs release postings). A non-zero
   * discrepancy means the operational record and the ledger disagree.
   */
  async reconciliation(programmeId: string): Promise<VoucherReconciliation> {
    const programme = await this.getProgramme(programmeId);
    const vouchers = await this.vouchers.find({ programmeId });
    const issued = vouchers.filter((voucher) => voucher.status === 'ISSUED');
    const outstandingKobo = issued.reduce((sum, voucher) => sum + voucher.amountKobo, 0);
    const redemptions = await this.redemptions.find({ programmeId });
    const redeemedKobo = redemptions.reduce((sum, redemption) => sum + redemption.amountKobo, 0);
    const balance = await this.ledger.balance(programme.liabilityAccountCode);
    const liabilityBalanceKobo = balance.creditsKobo - balance.debitsKobo;
    const expectedLiabilityKobo = programme.budgetKobo - redeemedKobo - this.releasedKobo(vouchers);
    const funding = await this.funding.getFunding(programmeId);
    return {
      programmeId,
      totals: {
        issuedCount: vouchers.length,
        redeemedCount: redemptions.length,
        expiredCount: vouchers.filter((voucher) => voucher.status === 'EXPIRED').length,
        voidedCount: vouchers.filter((voucher) => voucher.status === 'VOIDED').length,
        outstandingCount: issued.length,
        outstandingKobo,
        redeemedKobo
      },
      ledger: {
        liabilityAccountCode: programme.liabilityAccountCode,
        liabilityBalanceKobo,
        expectedLiabilityKobo,
        discrepancyKobo: liabilityBalanceKobo - expectedLiabilityKobo
      },
      funding: funding
        ? { ...funding, availableKobo: funding.fundedKobo - funding.reservedKobo - funding.settledKobo }
        : undefined
    };
  }

  private releasedKobo(vouchers: InputVoucherRecord[]): number {
    return vouchers
      .filter((voucher) => voucher.status === 'EXPIRED' || voucher.status === 'VOIDED')
      .reduce((sum, voucher) => sum + voucher.amountKobo, 0);
  }
}
