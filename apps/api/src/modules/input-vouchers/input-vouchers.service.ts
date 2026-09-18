import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException
} from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  BENEFICIARY_REPOSITORY,
  FARM_PLOT_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY,
  PARAMETRIC_POLICY_REPOSITORY,
  PARAMETRIC_PRODUCT_REPOSITORY,
  VOUCHER_COVER_REPOSITORY,
  VOUCHER_PROGRAMME_RIDER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { FarmPlotRepository } from '../../database/repositories/farms.repository.js';
import type {
  VoucherCoverRecord,
  VoucherCoverRepository,
  VoucherProgrammeRiderRecord,
  VoucherProgrammeRiderRepository
} from '../../database/repositories/insurance.repository.js';
import type {
  ParametricPolicyRepository,
  ParametricProductRepository
} from '../../database/repositories/insurance.repository.js';
import type {
  BeneficiaryRecord,
  BeneficiaryRepository,
  FundingEventRecord,
  InputVoucherRecord,
  InputVoucherRepository,
  ProgrammeFundingRecord,
  ProgrammeFundingRepository,
  ProgrammeStatus,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from '../../database/repositories/input-vouchers.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
import { computePremiumKobo } from '../insurance/premium.js';
import { createWeatherProvider } from '../insurance/weather.provider.js';
import {
  IDENTITY_VERIFICATION_PORT,
  type IdentityVerificationPort
} from './identity.driver.js';
import { InvalidNinError, hashNin, maskNin, resolveNinHashSalt } from './nin-crypto.js';

/** Platform expense account recognising encumbered subsidy budgets. */
export const PLATFORM_SUBSIDY_BUDGET_ACCOUNT = 'platform:subsidy_budget';

export function programmeLiabilityAccountCode(programmeId: string): string {
  return `programme:${programmeId}:liability`;
}

export function supplierReceivableAccountCode(supplierId: string): string {
  return `supplier:${supplierId}:receivable`;
}

/**
 * Stage 27 (Insurance-in-the-Bag): per-programme insurer premium payable
 * account. Redemption of a voucher under an active programme rider splits
 * the envelope in ONE ledger entry: DR programme liability (full face
 * value) / CR supplier receivable (face − premium) / CR this account
 * (premium). The premium therefore debits the funded envelope atomically
 * with the redemption — never as a separate, raceable posting.
 */
export function programmeInsurancePremiumAccountCode(programmeId: string): string {
  return `programme:${programmeId}:insurance_premium`;
}

/** Rollout flag for the voucher insurance rider (default OFF, fail-closed). */
export const VOUCHER_INSURANCE_RIDER_FLAG = 'voucher-insurance-rider';

/** Options for redemption: the planted plot the bundled cover attaches to. */
export interface RedeemVoucherOptions {
  plotId?: string;
  /**
   * W2-C2 (V-32): partial redemption amount. Defaults to the FULL remaining
   * balance (pre-W2 behaviour). Must be a positive integer ≤ the remaining
   * balance; an overshoot is rejected 422 and nothing is claimed.
   */
  amountKobo?: number;
}

/** Resolved cover plan for a redemption under an active rider. */
export interface VoucherCoverPlan {
  rider: VoucherProgrammeRiderRecord;
  productId: string;
  season: string;
  triggerMetric: string;
  plotId: string;
  premiumKobo: number;
  insurerAccountCode: string;
}

export interface ActorRef {
  id: string;
  roles: readonly string[];
}

export interface CreateProgrammeInput {
  name: string;
  sponsor: string;
  description?: string;
  /** Donor user funding the programme (V-61) — scopes donor reads to it. */
  funderId?: string;
  perFarmerCapKobo: number;
  budgetKobo: number;
  /** Empty/omitted = all states eligible. */
  eligibleStates?: string[];
  /** Empty/omitted = all crops eligible. */
  eligibleCrops?: string[];
}

export interface VerifyBeneficiaryInput {
  farmerId: string;
  /** Plaintext NIN — verified then DISCARDED; only hash + mask persist. */
  nin: string;
  fullName: string;
  state?: string;
  primaryCrop?: string;
}

export interface AllocateVoucherInput {
  farmerId: string;
  amountKobo: number;
  /** Mandatory client idempotency key; replays return the original voucher. */
  idempotencyKey: string;
  /** Optional ISO expiry; defaults to programme-agnostic 90 days. */
  expiresAt?: string;
}

export interface FundProgrammeInput {
  amountKobo: number;
  /**
   * Mandatory client idempotency key; a replay returns the original top-up
   * WITHOUT double-crediting the float (mirrors the allocation/top-up
   * idempotency doctrine from stage 22).
   */
  idempotencyKey: string;
  /** Optional sponsor/disbursement reference for the audit trail. */
  reference?: string;
}

export interface ProgrammeFundingView {
  programmeId: string;
  fundedKobo: number;
  reservedKobo: number;
  settledKobo: number;
  /** funded - reserved - settled: the maximum further face value issuable. */
  availableKobo: number;
}

export interface ProgrammeStateTotals {
  state: string;
  vouchersIssued: number;
  outstandingKobo: number;
  redeemedKobo: number;
}

export interface ProgrammeReconciliation {
  programmeId: string;
  budgetKobo: number;
  totals: {
    vouchersIssued: number;
    allocatedKobo: number;
    outstandingCount: number;
    outstandingKobo: number;
    redeemedCount: number;
    redeemedKobo: number;
    /** W2-C2 (V-02): vouchers refunded (REDEEMED→REFUNDED) and kobo returned. */
    refundedCount: number;
    refundedKobo: number;
    expiredCount: number;
    expiredKobo: number;
    voidedCount: number;
    voidedKobo: number;
    beneficiariesVerified: number;
  };
  byState: ProgrammeStateTotals[];
  ledger: {
    liabilityAccountCode: string;
    /** Credit balance (credits - debits) of the programme liability account. */
    liabilityKobo: number;
    /** budget - redeemed - released (expired + voided), derived operationally. */
    expectedLiabilityKobo: number;
    /** 0 when the double-entry math ties; non-zero flags an integrity breach. */
    discrepancyKobo: number;
  };
  /** Funded-float backing state (stage 23, audit C3); zeroed when never topped up. */
  funding: ProgrammeFundingView;
  /**
   * Stage 27 (Insurance-in-the-Bag): bundled-cover ledger tie. Present when
   * the cover repository is wired; asserts premium payable balance == sum of
   * bound cover premiums (non-zero discrepancy = integrity breach).
   */
  insurance?: {
    premiumPayableAccountCode: string;
    coversBound: number;
    premiumKobo: number;
    premiumPayableKobo: number;
    discrepancyKobo: number;
  };
  generatedAt: string;
}

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

/**
 * Input-subsidy e-voucher service (wave NINVOUCHER). Money stays in the
 * finance ledger — the voucher tables hold operational records only:
 *   activation : DR platform:subsidy_budget / CR programme:<id>:liability
 *                (encumber the whole budget envelope, idempotent on
 *                input-voucher-programme:<id>)
 *   redemption : DR programme:<id>:liability / CR supplier:<id>:receivable
 *                (idempotent on input-voucher-redemption:<voucherId>)
 *   void/expiry: DR programme:<id>:liability / CR platform:subsidy_budget
 *                (release the encumbrance, idempotent on
 *                input-voucher-release:<voucherId>)
 * So the liability credit balance ALWAYS equals budget - redeemed - released;
 * the reconciliation report asserts that tie.
 *
 * Race discipline (stage 22, audit C1-6): terminal transitions pass through
 * pending states (REDEEMING / EXPIRING / VOIDING). The compare-and-set into
 * the pending state happens BEFORE the ledger posting, so only the CAS
 * winner ever posts; a retry that finds a pending state resumes
 * finalization instead of reposting, and a posting failure rolls the claim
 * back to ISSUED best-effort. Allocation serialises the budget/cap check +
 * insert under the programme allocation lock (audit C2-10).
 *
 * Funded-float backing (stage 23, audit C3): a voucher is only signed when
 * the programme's funded float can back it. Issuance atomically reserves
 * face value (`funded - reserved - settled >= amount`, zero rows ⇒ 422 and
 * NOTHING is persisted); redemption moves reserved → settled exactly once
 * per voucher (marker-keyed); expiry/void releases the reservation. The
 * budget-envelope check stays as the allocation-policy cap.
 *
 * Identity: allocation requires a beneficiary verified through the fail-closed
 * IdentityVerificationPort (stub default, honestly labelled). The plaintext
 * NIN is never persisted — salted HMAC hash + last-3 mask only.
 */
@Injectable()
export class InputVouchersService {
  private readonly ninSalt: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    @Inject(INPUT_VOUCHER_PROGRAMME_REPOSITORY) private readonly programmes: SubsidyProgrammeRepository,
    @Inject(BENEFICIARY_REPOSITORY) private readonly beneficiaries: BeneficiaryRepository,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly vouchers: InputVoucherRepository,
    @Inject(INPUT_VOUCHER_REDEMPTION_REPOSITORY) private readonly redemptions: RedemptionRepository,
    @Inject(INPUT_VOUCHER_PROGRAMME_FUNDING_REPOSITORY) private readonly funding: ProgrammeFundingRepository,
    private readonly ledger: LedgerService,
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Inject(IDENTITY_VERIFICATION_PORT) private readonly identity: IdentityVerificationPort,
    @Optional() private readonly audit?: AuditService,
    @Optional() env: NodeJS.ProcessEnv = process.env,
    // Stage 27 (Insurance-in-the-Bag): optional cover-binding collaborators.
    // All resolve from the global DatabaseModule in the running app; they are
    // optional only so hand-rolled unit tests can construct the service
    // without them — a rider that is actually ACTIVE with unwired
    // collaborators fails closed (503) instead of silently skipping the bind.
    @Optional() @Inject(VOUCHER_PROGRAMME_RIDER_REPOSITORY) private readonly riders?: VoucherProgrammeRiderRepository,
    @Optional() @Inject(VOUCHER_COVER_REPOSITORY) private readonly covers?: VoucherCoverRepository,
    @Optional() @Inject(PARAMETRIC_PRODUCT_REPOSITORY) private readonly insuranceProducts?: ParametricProductRepository,
    @Optional() @Inject(PARAMETRIC_POLICY_REPOSITORY) private readonly insurancePolicies?: ParametricPolicyRepository,
    @Optional() @Inject(FARM_PLOT_REPOSITORY) private readonly plots?: FarmPlotRepository,
    @Optional() private readonly flags?: FeatureFlagsService,
    @Optional() private readonly telemetry?: TelemetryService
  ) {
    this.ninSalt = resolveNinHashSalt(env);
    this.env = env;
  }

  // ------------------------------------------------------------- programmes

  async createProgramme(input: CreateProgrammeInput, actorId: string): Promise<SubsidyProgrammeRecord> {
    if (!input.name?.trim()) {
      throw new BadRequestException('name is required');
    }
    if (!input.sponsor?.trim()) {
      throw new BadRequestException('sponsor is required');
    }
    assertPositiveKobo(input.perFarmerCapKobo, 'perFarmerCapKobo');
    assertPositiveKobo(input.budgetKobo, 'budgetKobo');
    if (input.perFarmerCapKobo > input.budgetKobo) {
      throw new BadRequestException('perFarmerCapKobo cannot exceed budgetKobo');
    }
    const id = newId('prog');
    const now = new Date().toISOString();
    // The liability account is provisioned up-front so activation posting
    // finds it; the encumbrance entry lands on ACTIVATION, not here.
    await this.ledger.ensureAccount({
      code: programmeLiabilityAccountCode(id),
      type: 'liability'
    });
    const record = await this.programmes.create({
      id,
      name: input.name.trim(),
      sponsor: input.sponsor.trim(),
      description: input.description?.trim() || undefined,
      status: 'DRAFT',
      funderId: input.funderId?.trim() || undefined,
      perFarmerCapKobo: input.perFarmerCapKobo,
      budgetKobo: input.budgetKobo,
      eligibleStates: (input.eligibleStates ?? []).map((state) => state.trim()).filter(Boolean),
      eligibleCrops: (input.eligibleCrops ?? []).map((crop) => crop.trim()).filter(Boolean),
      liabilityAccountCode: programmeLiabilityAccountCode(id),
      createdBy: actorId,
      createdAt: now,
      updatedAt: now
    });
    await this.events.publish(
      'inputvouchers.programme.created',
      { programmeId: id, sponsor: record.sponsor, budgetKobo: record.budgetKobo },
      actorId
    );
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.programme.created',
      entityType: 'input_vouchers_programmes',
      entityId: id,
      metadata: { name: record.name, sponsor: record.sponsor, budgetKobo: record.budgetKobo }
    });
    return record;
  }

  async getProgramme(id: string): Promise<SubsidyProgrammeRecord> {
    const programme = await this.programmes.findById(id);
    if (!programme) {
      throw new NotFoundException(`Programme '${id}' not found`);
    }
    return programme;
  }

  /**
   * Donor read scoping (V-61): a donor may read a programme's funding state,
   * voucher list or reconciliation ONLY when they fund it
   * (programme.funderId === actor.id); admins and regulators keep
   * programme-wide oversight. Programmes without a recorded funder (pre-082)
   * are admin/regulator-only for donors (fail closed).
   */
  async assertProgrammeReadScope(actor: ActorRef, programmeId: string): Promise<void> {
    if (!actor.roles.includes('donor')) {
      return; // admin/regulator reads are programme-wide by design
    }
    const programme = await this.getProgramme(programmeId);
    if (programme.funderId !== actor.id) {
      throw new ForbiddenException('Donors may only read programmes they fund');
    }
  }

  async listProgrammes(status?: ProgrammeStatus): Promise<SubsidyProgrammeRecord[]> {
    return this.programmes.find(status ? { status } : {});
  }

  /**
   * DRAFT→ACTIVE: encumbers the whole budget envelope in the ledger
   * (DR platform:subsidy_budget / CR programme liability), idempotent on
   * input-voucher-programme:<id>.
   */
  async activateProgramme(id: string, actorId: string): Promise<SubsidyProgrammeRecord> {
    const programme = await this.getProgramme(id);
    if (programme.status === 'ACTIVE') {
      return programme; // idempotent replay
    }
    if (programme.status !== 'DRAFT') {
      throw new BadRequestException(`Only DRAFT programmes can be activated (status is ${programme.status})`);
    }
    await this.ledger.ensureAccount({ code: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, type: 'expense' });
    await this.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-programme:${id}`,
        referenceType: 'input_voucher_programme_activation',
        referenceId: id,
        description: `Subsidy budget encumbrance for programme ${id}`,
        postings: [
          { accountCode: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, direction: 'debit', amountKobo: programme.budgetKobo },
          { accountCode: programme.liabilityAccountCode, direction: 'credit', amountKobo: programme.budgetKobo }
        ]
      },
      actorId
    );
    const updated = await this.programmes.updateExpected(
      id,
      { status: 'ACTIVE', updatedAt: new Date().toISOString() },
      { status: 'DRAFT' }
    );
    await this.events.publish('inputvouchers.programme.activated', { programmeId: id }, actorId);
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.programme.activated',
      entityType: 'input_vouchers_programmes',
      entityId: id,
      metadata: { budgetKobo: programme.budgetKobo }
    });
    return updated;
  }

  // ---------------------------------------------------------- funding float

  /**
   * Tops up the programme's funded float (stage 23, audit C3): money the
   * sponsor has actually provided, which is what issuance now reserves
   * against. Idempotent on the mandatory client key — a transport retry
   * returns the original top-up (`replayed: true`) WITHOUT double-crediting.
   */
  async fundProgramme(
    programmeId: string,
    input: FundProgrammeInput,
    actorId: string
  ): Promise<{ event: FundingEventRecord; funding: ProgrammeFundingView; replayed: boolean }> {
    await this.getProgramme(programmeId);
    assertPositiveKobo(input.amountKobo);
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey is required — funding top-ups must replay safely');
    }
    const result = await this.funding.creditTopUp({
      id: newId('ifev'),
      programmeId,
      kind: 'top_up',
      amountKobo: input.amountKobo,
      idempotencyKey: input.idempotencyKey.trim(),
      reference: input.reference?.trim() || undefined,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    if (!result.replayed) {
      await this.events.publish(
        'inputvouchers.programme.funded',
        { programmeId, amountKobo: input.amountKobo, fundedKobo: result.funding.fundedKobo },
        actorId
      );
      await this.audit?.record({
        actorId,
        action: 'inputvouchers.programme.funded',
        entityType: 'input_vouchers_programme_funding',
        entityId: programmeId,
        metadata: { amountKobo: input.amountKobo, reference: input.reference }
      });
    }
    return { event: result.event, funding: this.toFundingView(result.funding), replayed: result.replayed };
  }

  /** Funded-float view for operators/regulators; zeroed when never topped up. */
  async getProgrammeFunding(programmeId: string): Promise<ProgrammeFundingView> {
    await this.getProgramme(programmeId);
    const funding = await this.funding.getFunding(programmeId);
    return this.toFundingView(funding, programmeId);
  }

  private toFundingView(funding: ProgrammeFundingRecord | undefined, programmeId?: string): ProgrammeFundingView {
    const record = funding ?? {
      programmeId: programmeId ?? '',
      fundedKobo: 0,
      reservedKobo: 0,
      settledKobo: 0,
      updatedAt: ''
    };
    return {
      programmeId: record.programmeId,
      fundedKobo: record.fundedKobo,
      reservedKobo: record.reservedKobo,
      settledKobo: record.settledKobo,
      availableKobo: record.fundedKobo - record.reservedKobo - record.settledKobo
    };
  }

  /** ACTIVE→CLOSED: blocks new allocations; outstanding vouchers still settle. */
  async closeProgramme(id: string, actorId: string): Promise<SubsidyProgrammeRecord> {
    const programme = await this.getProgramme(id);
    if (programme.status === 'CLOSED') {
      return programme; // idempotent replay
    }
    if (programme.status !== 'ACTIVE') {
      throw new BadRequestException(`Only ACTIVE programmes can be closed (status is ${programme.status})`);
    }
    const updated = await this.programmes.updateExpected(
      id,
      { status: 'CLOSED', updatedAt: new Date().toISOString() },
      { status: 'ACTIVE' }
    );
    await this.events.publish('inputvouchers.programme.closed', { programmeId: id }, actorId);
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.programme.closed',
      entityType: 'input_vouchers_programmes',
      entityId: id
    });
    return updated;
  }

  // ----------------------------------------------------------- beneficiaries

  /**
   * Verifies a farmer's NIN through the identity port and enrols them as a
   * beneficiary. Idempotent per (programme, farmer): an existing enrolment
   * replays. The plaintext NIN is discarded after the call — only the salted
   * HMAC hash + last-3 mask persist. `basis` is stored honestly ('stub' until
   * the NIMC/licensed vendor gate opens).
   */
  async verifyBeneficiary(
    programmeId: string,
    input: VerifyBeneficiaryInput,
    actorId: string
  ): Promise<BeneficiaryRecord> {
    await this.getProgramme(programmeId);
    await this.users.getById(input.farmerId);
    const existing = await this.beneficiaries.findByProgrammeAndFarmer(programmeId, input.farmerId);
    if (existing) {
      return existing; // idempotent replay of the enrolment
    }
    let ninHash: string;
    let ninMask: string;
    try {
      ninHash = hashNin(input.nin, this.ninSalt);
      ninMask = maskNin(input.nin);
    } catch (error) {
      if (error instanceof InvalidNinError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    // Fail-closed port: a live-driver 503 propagates; verification failures
    // reject without persisting anything.
    const result = await this.identity.verify({
      nin: input.nin,
      fullName: input.fullName
    });
    // Fail closed (belt-and-braces behind the createIdentityDriver boot ban,
    // mirroring the warehouse deposit basis guard): a stub-basis verdict is a
    // publicly computable hash and must never enrol a beneficiary in
    // production, even if a stub port was injected by hand.
    if (isProduction() && result.basis !== 'live') {
      throw new ServiceUnavailableException(
        'NIN identity verification did not come from the live provider (basis is not live). ' +
          'Refusing the enrolment in production — configure NIN_DRIVER=live with the licensed ' +
          'identity vendor credentials.'
      );
    }
    if (!result.verified) {
      throw new BadRequestException(
        `NIN verification failed (basis: ${result.basis}). The farmer was NOT enrolled.`
      );
    }
    const record = await this.beneficiaries.create({
      id: newId('ben'),
      programmeId,
      farmerId: input.farmerId,
      ninHash,
      ninMask,
      verificationBasis: result.basis,
      nameMatchScore: result.nameMatchScore,
      state: input.state?.trim() || undefined,
      primaryCrop: input.primaryCrop?.trim() || undefined,
      verifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'inputvouchers.beneficiary.verified',
      { programmeId, farmerId: input.farmerId, basis: result.basis },
      actorId
    );
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.beneficiary.verified',
      entityType: 'input_vouchers_beneficiaries',
      entityId: record.id,
      metadata: { programmeId, farmerId: input.farmerId, ninMask, basis: result.basis }
    });
    return record;
  }

  async listBeneficiaries(programmeId: string): Promise<BeneficiaryRecord[]> {
    await this.getProgramme(programmeId);
    return this.beneficiaries.find({ programmeId });
  }

  // --------------------------------------------------------------- vouchers

  /**
   * Allocates a voucher to a verified beneficiary. Idempotent on the client
   * idempotency key (replay returns the original). Enforces the programme
   * allocation rules: ACTIVE status, NIN-verified beneficiary, eligible
   * state/crop, per-farmer cap, the remaining budget envelope AND the
   * funded-float backing check (stage 23, audit C3): the face value reserves
   * atomically against funded money, so an unbacked programme rejects with
   * 422 and nothing is signed or persisted.
   */
  async allocateVoucher(
    programmeId: string,
    input: AllocateVoucherInput,
    actorId: string
  ): Promise<InputVoucherRecord> {
    const replay = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      this.assertAllocationReplayMatches(replay, programmeId, input);
      return replay; // idempotent replay of a transport retry
    }
    const programme = await this.getProgramme(programmeId);
    if (programme.status !== 'ACTIVE') {
      throw new BadRequestException(`Programme must be ACTIVE to allocate (status is ${programme.status})`);
    }
    assertPositiveKobo(input.amountKobo);
    const beneficiary = await this.beneficiaries.findByProgrammeAndFarmer(programmeId, input.farmerId);
    if (!beneficiary) {
      throw new BadRequestException('Farmer is not a NIN-verified beneficiary of this programme');
    }
    this.assertEligibility(programme, beneficiary);
    const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_VOUCHER_TTL_MS).toISOString();
    if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new BadRequestException('expiresAt must be a future ISO-8601 timestamp');
    }
    // Allocation rules: live obligations (ISSUED + in-flight REDEEMING +
    // REDEEMED) count against the per-farmer cap and the budget envelope;
    // EXPIRED/VOIDED released them. The check+insert runs under the
    // per-programme allocation lock (pg: SELECT ... FOR UPDATE on the
    // programme row) so concurrent allocations cannot both pass the budget
    // check (stage 22, audit C2-10).
    const record = await this.programmes.withAllocationLock(programmeId, async (tx) => {
      // Re-check the idempotency key INSIDE the lock: a twin request may
      // have committed while this one waited on the programme row — replay
      // it here so we never reserve the float twice for one voucher.
      const twin = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
      if (twin) {
        this.assertAllocationReplayMatches(twin, programmeId, input);
        return twin;
      }
      const live = (await this.vouchers.find({ programmeId })).filter(
        (voucher) =>
          voucher.status === 'ISSUED' || voucher.status === 'REDEEMING' || voucher.status === 'REDEEMED'
      );
      const farmerUsed = live
        .filter((voucher) => voucher.farmerId === input.farmerId)
        .reduce((sum, voucher) => sum + voucher.amountKobo, 0);
      if (farmerUsed + input.amountKobo > programme.perFarmerCapKobo) {
        throw new BadRequestException(
          `Per-farmer cap exceeded: ${farmerUsed + input.amountKobo} kobo would pass the ${programme.perFarmerCapKobo} kobo cap`
        );
      }
      const programmeUsed = live.reduce((sum, voucher) => sum + voucher.amountKobo, 0);
      if (programmeUsed + input.amountKobo > programme.budgetKobo) {
        throw new BadRequestException(
          `Programme budget exceeded: ${programmeUsed + input.amountKobo} kobo would pass the ${programme.budgetKobo} kobo envelope`
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

  private assertEligibility(programme: SubsidyProgrammeRecord, beneficiary: BeneficiaryRecord): void {
    if (programme.eligibleStates.length > 0) {
      const state = beneficiary.state?.toLowerCase();
      if (!state || !programme.eligibleStates.map((item) => item.toLowerCase()).includes(state)) {
        throw new BadRequestException(
          `Beneficiary state '${beneficiary.state ?? 'unknown'}' is not eligible for this programme`
        );
      }
    }
    if (programme.eligibleCrops.length > 0) {
      const crop = beneficiary.primaryCrop?.toLowerCase();
      if (!crop || !programme.eligibleCrops.map((item) => item.toLowerCase()).includes(crop)) {
        throw new BadRequestException(
          `Beneficiary crop '${beneficiary.primaryCrop ?? 'unknown'}' is not eligible for this programme`
        );
      }
    }
  }

  async getVoucher(id: string): Promise<InputVoucherRecord> {
    const voucher = await this.vouchers.findById(id);
    if (!voucher) {
      throw new NotFoundException(`Voucher '${id}' not found`);
    }
    return voucher;
  }

  async listVouchers(filter: {
    programmeId?: string;
    farmerId?: string;
    status?: InputVoucherRecord['status'];
  }): Promise<InputVoucherRecord[]> {
    return this.vouchers.find(filter);
  }

  /** Marks an ISSUED voucher as distributed — the farmer can now see/redeem it. */
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
    await this.events.publish(
      'inputvouchers.voucher.distributed',
      { voucherId: id, programmeId: voucher.programmeId, farmerId: voucher.farmerId },
      actorId
    );
    return updated;
  }

  /**
   * Redeems a voucher at an agro-dealer (supplier role) against an invoice
   * reference. Anti-double-spend (stage 22, audit C1-6 — escrow pending-state
   * pattern): the voucher CASes ISSUED→REDEEMING BEFORE any ledger posting,
   * so only the CAS winner ever posts — a concurrent expire/void loses the
   * same CAS and can no longer double-debit the programme liability. The
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
    actor: ActorRef,
    options: RedeemVoucherOptions = {}
  ): Promise<{ voucher: InputVoucherRecord; redemption: RedemptionRecord; cover?: VoucherCoverRecord }> {
    if (!invoiceRef?.trim()) {
      throw new BadRequestException('invoiceRef is required — redemptions settle against a dealer invoice');
    }
    let voucher = await this.getVoucher(id);
    if (voucher.status === 'REDEEMED') {
      throw new ConflictException(`Voucher '${id}' has already been redeemed`);
    }
    if (voucher.status === 'REFUNDED' || voucher.status === 'REFUNDING') {
      throw new ConflictException(`Voucher '${id}' has been refunded (status is ${voucher.status})`);
    }
    if (voucher.status === 'VOIDED' || voucher.status === 'VOIDING') {
      throw new ConflictException(`Voucher '${id}' was voided`);
    }
    if (voucher.status === 'EXPIRED' || voucher.status === 'EXPIRING') {
      if (voucher.status === 'EXPIRING') {
        await this.expireIssuedVoucher(voucher, actor.id); // resume a stuck expiry
      }
      throw new GoneException(`Voucher '${id}' expired at ${voucher.expiresAt}`);
    }
    if (
      (voucher.status === 'ISSUED' || voucher.status === 'PARTIALLY_REDEEMED') &&
      Date.parse(voucher.expiresAt) <= Date.now()
    ) {
      await this.expireIssuedVoucher(voucher, actor.id);
      throw new GoneException(`Voucher '${id}' expired at ${voucher.expiresAt}`);
    }
    // A REDEEMING voucher resumes below regardless of the expiry clock — the
    // claim was taken while the voucher was valid and must settle exactly once.
    if (!voucher.distributedAt) {
      throw new BadRequestException(`Voucher '${id}' has not been distributed to the farmer yet`);
    }
    // W2-C2 (V-32): balance-bearing redemption. The remaining balance is the
    // face value minus the sum of committed parts (stored on the row); the
    // part amount defaults to the FULL remaining balance (pre-W2 behaviour).
    // A REDEEMING resume always uses the amount captured by the claim CAS —
    // never a freshly-computed one — so a crash mid-part cannot resize it.
    const redeemedSoFar = voucher.redeemedAmountKobo ?? 0;
    const remainingKobo = voucher.amountKobo - redeemedSoFar;
    const partAmountKobo =
      voucher.status === 'REDEEMING'
        ? (voucher.pendingAmountKobo ?? remainingKobo)
        : (options.amountKobo ?? remainingKobo);
    assertPositiveKobo(partAmountKobo);
    if (voucher.status !== 'REDEEMING' && partAmountKobo > remainingKobo) {
      throw new UnprocessableEntityException(
        `Voucher '${id}' remaining balance is ${remainingKobo} kobo — a ${partAmountKobo} kobo redemption overshoots the face value`
      );
    }
    const { seq: partSeq, key: redemptionKey } = await this.nextRedemptionPart(voucher);
    // Stage 27 (Insurance-in-the-Bag): resolve the programme's insurance
    // rider BEFORE the claim CAS, so a validation failure (no plot, premium
    // not covered by the face value) rejects the redemption while the
    // voucher is still ISSUED — the "policy issue failure rolls back the
    // redemption" doctrine. Post-claim failures are crash-class and resume
    // through the REDEEMING path below. Flag OFF (default) => no rider
    // consult, redemption behaves exactly as before.
    // W2-C2 (V-32): a programme insurance rider binds the WHOLE envelope in
    // one envelope-split entry — partial redemptions are incompatible with
    // the single-premium bind, so rider programmes require full-amount
    // redemption (fail closed 422 BEFORE any claim).
    const coverPlan = await this.resolveCoverPlan(voucher, options.plotId, actor);
    if (coverPlan && partAmountKobo !== remainingKobo) {
      throw new UnprocessableEntityException(
        `Voucher '${id}' is under a programme insurance rider — the envelope (including the bundled premium) must be redeemed in full`
      );
    }
    if (voucher.status === 'ISSUED' || voucher.status === 'PARTIALLY_REDEEMED') {
      // Claim the redemption FIRST: after this write only this caller (or a
      // retry resuming the claim) can reach the ledger posting; a concurrent
      // redeem/expire/void loses the CAS and surfaces as a 409. The claimed
      // PART amount rides the claim (pending_amount_kobo) so a crash-resume
      // finalizes exactly the claimed amount — never a recomputed one.
      voucher = await this.vouchers.updateExpected(
        id,
        { status: 'REDEEMING', pendingAmountKobo: partAmountKobo },
        { status: voucher.status }
      );
    }
    let redemption = await this.redemptions.findByIdempotencyKey(redemptionKey);
    let cover: VoucherCoverRecord | undefined;
    if (!redemption) {
      const programme = await this.getProgramme(voucher.programmeId);
      await this.ledger.ensureAccount({
        code: supplierReceivableAccountCode(actor.id),
        type: 'liability',
        ownerId: actor.id
      });
      // Stage 27: when a rider plan resolved, the premium rides the SAME
      // ledger entry as the redemption (envelope split) — one atomic,
      // idempotency-keyed posting: DR programme liability (full face value)
      // / CR supplier receivable (face − premium) / CR insurer premium
      // payable (premium). The funded-float reservation already backs the
      // full face value, so the premium is backed by the same funded money.
      if (coverPlan) {
        await this.ledger.ensureAccount({ code: coverPlan.insurerAccountCode, type: 'liability' });
      }
      const postings = coverPlan
        ? [
            { accountCode: programme.liabilityAccountCode, direction: 'debit' as const, amountKobo: partAmountKobo },
            {
              accountCode: supplierReceivableAccountCode(actor.id),
              direction: 'credit' as const,
              amountKobo: partAmountKobo - coverPlan.premiumKobo
            },
            { accountCode: coverPlan.insurerAccountCode, direction: 'credit' as const, amountKobo: coverPlan.premiumKobo }
          ]
        : [
            { accountCode: programme.liabilityAccountCode, direction: 'debit' as const, amountKobo: partAmountKobo },
            { accountCode: supplierReceivableAccountCode(actor.id), direction: 'credit' as const, amountKobo: partAmountKobo }
          ];
      try {
        const entry = await this.ledger.postEntry(
          {
            idempotencyKey: redemptionKey,
            referenceType: 'input_voucher_redemption',
            referenceId: voucher.id,
            description:
              `Subsidy voucher ${voucher.id} redemption part ${partSeq} (${partAmountKobo} kobo) by supplier ${actor.id} (invoice ${invoiceRef.trim()})` +
              (coverPlan ? ` — bundled insurance premium ${coverPlan.premiumKobo} kobo (envelope split)` : ''),
            postings
          },
          actor.id
        );
        if (coverPlan) {
          // Bind the cover BEFORE the redemption row so a crash anywhere in
          // this block resumes with the cover adopted (UNIQUE voucher_id),
          // never double-bound.
          cover = await this.bindVoucherCover(voucher, coverPlan);
        } else if (this.covers) {
          // Resume edge: a crashed attempt may have bound the cover under a
          // flag state the retry no longer resolves — adopt the row so the
          // settled view stays consistent with the posted envelope split.
          cover = await this.covers.findByVoucherId(voucher.id);
        }
        redemption = await this.redemptions.create({
          id: newId('ired'),
          voucherId: voucher.id,
          partSeq,
          programmeId: voucher.programmeId,
          supplierId: actor.id,
          invoiceRef: invoiceRef.trim(),
          amountKobo: partAmountKobo,
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
    // Move the claimed part of the float reservation to settled (stage 23,
    // audit C3; W2-C2 per-part). Marker-keyed per voucher PART, so a
    // crash-resume or concurrent retry replays as a no-op instead of
    // double-settling; runs BEFORE the finalize CAS so a settled part always
    // implies its reservation moved.
    await this.funding.settleReserved(
      voucher.programmeId,
      partAmountKobo,
      partSeq === 1
        ? `input-voucher-funding-settle:${voucher.id}`
        : `input-voucher-funding-settle:${voucher.id}:part-${partSeq}`,
      actor.id
    );
    // Finalize: REDEEMING→REDEEMED (balance exhausted) or →PARTIALLY_REDEEMED
    // (balance remains). A twin that already finalized loses this CAS and
    // surfaces as a 409 — the voucher pays out each part exactly once.
    const newRedeemedKobo = (voucher.redeemedAmountKobo ?? 0) + partAmountKobo;
    const fullyRedeemed = newRedeemedKobo >= voucher.amountKobo;
    const redeemed = await this.vouchers.updateExpected(
      id,
      {
        status: fullyRedeemed ? 'REDEEMED' : 'PARTIALLY_REDEEMED',
        redeemedAmountKobo: newRedeemedKobo,
        pendingAmountKobo: undefined,
        ...(fullyRedeemed ? { redeemedAt: new Date().toISOString() } : {}),
        ledgerEntryId: redemption.ledgerEntryId
      },
      { status: 'REDEEMING' }
    );
    await this.events.publish(
      'inputvouchers.voucher.redeemed',
      {
        voucherId: voucher.id,
        programmeId: voucher.programmeId,
        farmerId: voucher.farmerId,
        supplierId: actor.id,
        amountKobo: partAmountKobo,
        partSeq,
        redeemedAmountKobo: newRedeemedKobo,
        remainingKobo: voucher.amountKobo - newRedeemedKobo
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'inputvouchers.voucher.redeemed',
      entityType: 'input_vouchers_vouchers',
      entityId: voucher.id,
      metadata: {
        programmeId: voucher.programmeId,
        amountKobo: partAmountKobo,
        partSeq,
        redeemedAmountKobo: newRedeemedKobo,
        invoiceRef: invoiceRef.trim()
      }
    });
    if (cover) {
      // Policy issuance event AFTER the redemption committed (outbox), per
      // the money doctrine — a failure here can never roll back a settled
      // redemption, and a client retry replays the settled view (the cover
      // row already exists, so the resume path never double-binds).
      await this.events.publish(
        'insurance.voucher_cover.bound',
        {
          coverId: cover.id,
          voucherId: voucher.id,
          policyId: cover.policyId,
          programmeId: voucher.programmeId,
          farmerId: voucher.farmerId,
          plotId: cover.plotId,
          premiumKobo: cover.premiumKobo,
          coverBasis: cover.coverBasis
        },
        actor.id
      );
      await this.audit?.record({
        actorId: actor.id,
        action: 'insurance.voucher_cover.bound',
        entityType: 'insurance_voucher_covers',
        entityId: cover.id,
        metadata: {
          voucherId: voucher.id,
          policyId: cover.policyId,
          programmeId: voucher.programmeId,
          premiumKobo: cover.premiumKobo,
          coverBasis: cover.coverBasis
        }
      });
      this.telemetry?.increment('insurance.voucher_covers_bound_total', 1, {
        programme_id: voucher.programmeId,
        trigger_type: coverPlan?.triggerMetric ?? 'resumed'
      });
      this.telemetry?.increment('insurance.voucher_premium_kobo_total', cover.premiumKobo, {
        programme_id: voucher.programmeId
      });
    }
    return { voucher: redeemed, redemption, ...(cover ? { cover } : {}) };
  }

  /**
   * Stage 27 (Insurance-in-the-Bag): resolves the cover plan for a voucher
   * redemption. Returns undefined (redeem unchanged) when the rollout flag
   * is off for the caller, no rider exists, or the rider is suspended. When
   * an active rider exists the plan is fully validated HERE — before the
   * redemption claim CAS — so a product/plot/premium failure rejects the
   * redemption with the voucher still ISSUED (422/404), never leaving a
   * half-bound cover. Fail-closed: an active rider with unwired cover
   * collaborators is a 503, not a silent skip.
   */
  private async resolveCoverPlan(
    voucher: InputVoucherRecord,
    plotId: string | undefined,
    actor: ActorRef
  ): Promise<VoucherCoverPlan | undefined> {
    if (!this.flags || !this.riders) {
      return undefined;
    }
    const enabled = await this.flags.isEnabled(VOUCHER_INSURANCE_RIDER_FLAG, {
      userId: actor.id,
      roles: [...actor.roles]
    });
    if (!enabled) {
      return undefined;
    }
    const rider = await this.riders.findByProgrammeId(voucher.programmeId);
    if (!rider || rider.status !== 'active') {
      return undefined;
    }
    if (!this.covers || !this.insuranceProducts || !this.insurancePolicies || !this.plots) {
      throw new ServiceUnavailableException(
        'The programme insurance rider is active but the cover-binding persistence is not wired — refusing to redeem without binding'
      );
    }
    const product = await this.insuranceProducts.findOne({ code: rider.productCode });
    if (!product) {
      throw new UnprocessableEntityException(
        `RIDER_PRODUCT_UNKNOWN: the programme rider references insurance product '${rider.productCode}', which is not in the catalog`
      );
    }
    if (!plotId?.trim()) {
      throw new UnprocessableEntityException(
        'PLOT_REQUIRED: this programme bundles parametric cover on the planted plot — pass plotId at redemption'
      );
    }
    const plot = await this.plots.findById(plotId.trim());
    if (!plot) {
      throw new NotFoundException(`Plot '${plotId.trim()}' not found`);
    }
    if (plot.ownerUserId !== voucher.farmerId) {
      throw new UnprocessableEntityException(
        'PLOT_OWNER_MISMATCH: the cover plot must belong to the voucher farmer'
      );
    }
    // Deterministic rate card (premium.ts): sum insured × rate × flood-band
    // modifier. The flood band was captured at rider-definition time — the
    // stub flood driver is never consulted on the redemption money path.
    const { premiumKobo } = computePremiumKobo({
      sumInsuredKobo: rider.sumInsuredKobo,
      premiumRateBps: rider.premiumRateBps,
      floodBand: rider.floodBand
    });
    if (premiumKobo <= 0 || premiumKobo >= voucher.amountKobo) {
      throw new UnprocessableEntityException(
        `PREMIUM_EXCEEDS_ENVELOPE: the bundled premium (${premiumKobo} kobo) is not covered by the voucher face value (${voucher.amountKobo} kobo)`
      );
    }
    return {
      rider,
      productId: product.id,
      season: product.trigger.season,
      triggerMetric: product.trigger.metric,
      plotId: plot.id,
      premiumKobo,
      insurerAccountCode: programmeInsurancePremiumAccountCode(voucher.programmeId)
    };
  }

  /**
   * Stage 27: binds the voucher cover exactly once per voucher. The cover
   * row is inserted FIRST with a pre-generated policy id (UNIQUE voucher_id
   * — a crash-resume or racing twin adopts the existing row), then the
   * parametric policy is created under that id (23505 → adopt). The policy
   * enters as 'active' (a bound cover) so the existing trigger-evaluation
   * and payout path — including its production fail-closed gates — applies
   * unchanged. cover_basis is stamped honestly from the configured weather
   * provider ('stub' until the live provider gate opens).
   */
  private async bindVoucherCover(
    voucher: InputVoucherRecord,
    plan: VoucherCoverPlan
  ): Promise<VoucherCoverRecord> {
    const covers = this.covers as VoucherCoverRepository;
    const policies = this.insurancePolicies as ParametricPolicyRepository;
    return (this.telemetry ?? new TelemetryService()).withSpan(
      'insurance.voucher_cover.bind',
      { programme_id: voucher.programmeId, trigger_type: plan.triggerMetric },
      async () => {
        const now = new Date().toISOString();
        let cover = await covers.findByVoucherId(voucher.id);
        if (!cover) {
          const coverBasis: 'stub' | 'live' =
            createWeatherProvider(this.env).name === 'http' ? 'live' : 'stub';
          try {
            cover = await covers.create({
              id: newId('ivcov'),
              voucherId: voucher.id,
              policyId: newId('inspol'),
              programmeId: voucher.programmeId,
              plotId: plan.plotId,
              farmerId: voucher.farmerId,
              premiumKobo: plan.premiumKobo,
              coverBasis,
              status: 'bound',
              createdAt: now,
              updatedAt: now
            });
          } catch (error) {
            if (!(error instanceof ConflictException)) {
              throw error;
            }
            // Twin won the UNIQUE voucher_id race — adopt its row.
            cover = await covers.findByVoucherId(voucher.id);
            if (!cover) {
              throw error;
            }
          }
        }
        try {
          await policies.create({
            id: cover.policyId,
            farmerUserId: voucher.farmerId,
            plotId: cover.plotId,
            productId: plan.productId,
            productCode: plan.rider.productCode,
            season: plan.season,
            sumInsuredKobo: plan.rider.sumInsuredKobo,
            premiumKobo: cover.premiumKobo,
            floodBand: plan.rider.floodBand,
            pricingBasis: cover.coverBasis,
            status: 'active',
            createdAt: now,
            updatedAt: now
          });
        } catch (error) {
          if (!(error instanceof ConflictException)) {
            throw error;
          }
          // Policy already exists under the cover's pinned id (twin/resume).
          const existing = await policies.findById(cover.policyId);
          if (!existing) {
            throw error;
          }
        }
        return cover;
      }
    );
  }

  /**
   * ISSUED→VOIDING→VOIDED (admin) with encumbrance release back to the
   * budget expense. The CAS into VOIDING happens BEFORE the release posting
   * (stage 22, audit C1-6): a concurrent redemption loses the same CAS, so
   * the programme liability is debited exactly once. A retry that finds
   * VOIDING resumes finalization; the release posting is idempotent on
   * input-voucher-release:<id>.
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
      await this.releaseEncumbrance(voucher, actorId, 'void', voucher.amountKobo);
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
    const updated = await this.vouchers.updateExpected(
      id,
      { status: 'VOIDED', voidedAt: new Date().toISOString() },
      { status: 'VOIDING' }
    );
    await this.events.publish(
      'inputvouchers.voucher.voided',
      { voucherId: id, programmeId: voucher.programmeId },
      actorId
    );
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.voucher.voided',
      entityType: 'input_vouchers_vouchers',
      entityId: id,
      metadata: { programmeId: voucher.programmeId, amountKobo: voucher.amountKobo }
    });
    return updated;
  }

  /**
   * Crash-resume for a REDEEMING voucher whose claim outlived the stuck TTL
   * (WP-G12 sweeper path; also safe for admin/manual invocation):
   *   - redemption row exists → the posting committed; settle the float
   *     reservation (marker-keyed, replay-no-op) and finalize
   *     REDEEMING→REDEEMED, exactly like the redeem tail. The finalize CAS
   *     loses against a concurrent redeem retry — that retry already owns
   *     finalization, so the loser surfaces 409 and nothing double-posts.
   *   - no redemption row → roll the claim back REDEEMING→ISSUED ONLY when
   *     the ledger PROVES no redemption entry exists under the operation key
   *     (stage 24, audit A4-1/A1-3); when the entry exists or the probe is
   *     inconclusive the claim stays REDEEMING for the next pass and the
   *     caller surfaces a 409 — never a re-opened voucher on top of a
   *     committed posting.
   */
  async recoverStuckRedemption(id: string, actorId: string): Promise<InputVoucherRecord> {
    const voucher = await this.getVoucher(id);
    if (voucher.status !== 'REDEEMING') {
      throw new ConflictException(
        `Only REDEEMING vouchers need stuck-claim recovery (status is ${voucher.status})`
      );
    }
    // W2-C2 (V-32): the in-flight part is recomputed exactly as the claim
    // took it (nextRedemptionPart reuses the in-flight row's key), and the
    // amount comes from pending_amount_kobo captured by the claim CAS.
    const { seq: partSeq, key: redemptionKey } = await this.nextRedemptionPart(voucher);
    const partAmountKobo =
      voucher.pendingAmountKobo ?? voucher.amountKobo - (voucher.redeemedAmountKobo ?? 0);
    const redemption =
      (await this.redemptions.findByIdempotencyKey(redemptionKey)) ??
      (await this.probeRedemptionRow(redemptionKey));
    if (redemption) {
      // Resume the redeem tail: settle the reservation BEFORE the finalize
      // CAS so a settled part always implies its reservation moved.
      await this.funding.settleReserved(
        voucher.programmeId,
        redemption.amountKobo,
        partSeq === 1
          ? `input-voucher-funding-settle:${voucher.id}`
          : `input-voucher-funding-settle:${voucher.id}:part-${partSeq}`,
        actorId
      );
      const newRedeemedKobo = (voucher.redeemedAmountKobo ?? 0) + redemption.amountKobo;
      const fullyRedeemed = newRedeemedKobo >= voucher.amountKobo;
      const redeemed = await this.vouchers.updateExpected(
        id,
        {
          status: fullyRedeemed ? 'REDEEMED' : 'PARTIALLY_REDEEMED',
          redeemedAmountKobo: newRedeemedKobo,
          pendingAmountKobo: undefined,
          ...(fullyRedeemed ? { redeemedAt: new Date().toISOString() } : {}),
          ledgerEntryId: redemption.ledgerEntryId
        },
        { status: 'REDEEMING' }
      );
      await this.events.publish(
        'inputvouchers.voucher.redeemed',
        {
          voucherId: voucher.id,
          programmeId: voucher.programmeId,
          farmerId: voucher.farmerId,
          supplierId: redemption.supplierId,
          amountKobo: redemption.amountKobo,
          partSeq,
          redeemedAmountKobo: newRedeemedKobo,
          resumedBy: 'sweeper'
        },
        actorId
      );
      await this.audit?.record({
        actorId,
        action: 'inputvouchers.voucher.redemption_resumed',
        entityType: 'input_vouchers_vouchers',
        entityId: id,
        metadata: { programmeId: voucher.programmeId, amountKobo: redemption.amountKobo, partSeq }
      });
      return redeemed;
    }
    void partAmountKobo; // amount already cross-checked via the redemption row above
    const probe = await this.probeLedgerEntry(redemptionKey);
    if (probe.state === 'absent') {
      // Proven: nothing posted under this key — safe to re-open the voucher;
      // the normal expire/redeem paths take it from here. The rollback target
      // preserves earlier committed parts (V-32): a voucher with redeemed
      // balance returns to PARTIALLY_REDEEMED, not ISSUED.
      const rolledBack = await this.vouchers.updateExpected(
        id,
        { status: (voucher.redeemedAmountKobo ?? 0) > 0 ? 'PARTIALLY_REDEEMED' : 'ISSUED', pendingAmountKobo: undefined },
        { status: 'REDEEMING' }
      );
      await this.audit?.record({
        actorId,
        action: 'inputvouchers.voucher.redemption_rolled_back',
        entityType: 'input_vouchers_vouchers',
        entityId: id,
        metadata: { programmeId: voucher.programmeId, reason: 'stuck_claim_unposted' }
      });
      return rolledBack;
    }
    throw new ConflictException(
      `Voucher '${id}' redemption posting state is uncertain — the claim stays REDEEMING ` +
        'for a safe resume; retry the recovery'
    );
  }

  /**
   * W2-C2 (V-32): the in-flight redemption part for a voucher. Rows whose
   * amounts are already reflected in redeemed_amount_kobo are COMMITTED; the
   * first row beyond the committed sum is the in-flight part (crash between
   * the ledger posting/row insert and the finalize CAS) and its key MUST be
   * reused so a resume adopts it instead of reposting under a fresh key.
   * Part 1 keeps the legacy key (input-voucher-redemption:<id>) so pre-W2
   * stuck claims resume unchanged; later parts derive per-part keys.
   */
  private async nextRedemptionPart(voucher: InputVoucherRecord): Promise<{ seq: number; key: string }> {
    const rows = (await this.redemptions.find({ voucherId: voucher.id }))
      .slice()
      .sort((a, b) => (a.partSeq ?? 1) - (b.partSeq ?? 1) || a.createdAt.localeCompare(b.createdAt));
    let committedKobo = voucher.redeemedAmountKobo ?? 0;
    let seq = rows.length + 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (committedKobo >= rows[i].amountKobo) {
        committedKobo -= rows[i].amountKobo;
      } else {
        seq = rows[i].partSeq ?? i + 1;
        break;
      }
    }
    const key =
      seq === 1 ? `input-voucher-redemption:${voucher.id}` : `input-voucher-redemption:${voucher.id}:part-${seq}`;
    return { seq, key };
  }

  /**
   * W2-C2 (V-02) — refund/reversal of a redeemed subsidy voucher
   * (admin-triggered; e.g. counterfeit-input discovery on a complaint case).
   * REDEEMED/PARTIALLY_REDEEMED → REFUNDING → REFUNDED through the same
   * claim-then-finalize CAS doctrine as redeem/expire:
   *   1. CAS into REFUNDING (stores reason + complaintCaseId on the row so a
   *      crash-resume or the sweeper completes with the SAME parameters);
   *   2. reverse every redemption part's ledger entry — exact inverse,
   *      balanced counter-postings (DR supplier receivable / CR programme
   *      liability [+ DR insurer premium when a rider split the envelope]),
   *      idempotent per entry via reverseEntry (`reversal:<entryId>`). This
   *      is the dealer-settlement clawback: the supplier receivable is
   *      debited back;
   *   3. return the settled float to available (marker-keyed
   *      `input-voucher-funding-refund:<id>`) and, for a partially redeemed
   *      voucher, release the REMAINING encumbrance exactly like expiry
   *      (`input-voucher-release:<id>`);
   *   4. finalize REFUNDING → REFUNDED with refundedAt/refundedAmountKobo.
   * Every posting is idempotent, so a REFUNDING voucher is resumable forever
   * (retry here or via the stuck-voucher sweeper) and NEVER rolls back —
   * rolling back would re-open a voucher whose reversal already paid out.
   */
  async refundVoucher(
    id: string,
    actorId: string,
    input: { reason?: string; complaintCaseId?: string } = {}
  ): Promise<InputVoucherRecord> {
    let voucher = await this.getVoucher(id);
    if (voucher.status === 'REFUNDED') {
      return voucher; // idempotent replay of a completed refund
    }
    if (
      voucher.status !== 'REDEEMED' &&
      voucher.status !== 'PARTIALLY_REDEEMED' &&
      voucher.status !== 'REFUNDING'
    ) {
      throw new ConflictException(
        `Only REDEEMED or PARTIALLY_REDEEMED vouchers can be refunded (status is ${voucher.status})`
      );
    }
    if (voucher.status !== 'REFUNDING') {
      // Claim the refund FIRST: a concurrent redeem-resume/expire/void loses
      // this CAS and surfaces 409 — the reversal below is the only writer.
      voucher = await this.vouchers.updateExpected(
        id,
        {
          status: 'REFUNDING',
          refundReason: input.reason?.trim() || undefined,
          complaintCaseId: input.complaintCaseId?.trim() || undefined,
          pendingAmountKobo: undefined
        },
        { status: voucher.status }
      );
    }
    const parts = await this.redemptions.find({ voucherId: id });
    const refundedKobo = parts.reduce((sum, part) => sum + part.amountKobo, 0);
    if (refundedKobo <= 0) {
      throw new ConflictException(`Voucher '${id}' has no settled redemption to refund`);
    }
    // Compensating balanced entries: exact inverse of each redemption part.
    for (const part of parts) {
      await this.ledger.reverseEntry(part.ledgerEntryId, actorId);
    }
    // Return the settled float to the programme's available headroom exactly
    // once (marker-keyed; replay-no-op).
    await this.funding.refundSettled(
      voucher.programmeId,
      refundedKobo,
      `input-voucher-funding-refund:${voucher.id}`,
      actorId
    );
    // The voucher is terminally REFUNDED: the reversal restored the redeemed
    // money to the programme liability, so now release the FULL face value to
    // the budget — exactly like an expiry release (same idempotency key,
    // same legs), leaving no dead obligation on the liability account.
    // The funding side releases only the still-RESERVED remainder (parts
    // settled individually were already returned by refundSettled above).
    const remainingKobo = voucher.amountKobo - refundedKobo;
    await this.releaseEncumbrance(voucher, actorId, 'refund', voucher.amountKobo);
    if (remainingKobo > 0) {
      await this.funding.releaseReserved(
        voucher.programmeId,
        remainingKobo,
        `input-voucher-funding-release:${voucher.id}`,
        actorId
      );
    }
    const refunded = await this.vouchers.updateExpected(
      id,
      {
        status: 'REFUNDED',
        refundedAt: new Date().toISOString(),
        refundedAmountKobo: refundedKobo
      },
      { status: 'REFUNDING' }
    );
    await this.events.publish(
      'inputvouchers.voucher.refunded',
      {
        voucherId: voucher.id,
        programmeId: voucher.programmeId,
        farmerId: voucher.farmerId,
        refundedAmountKobo: refundedKobo,
        complaintCaseId: voucher.complaintCaseId,
        reason: voucher.refundReason
      },
      actorId
    );
    await this.audit?.record({
      actorId,
      action: 'inputvouchers.voucher.refunded',
      entityType: 'input_vouchers_vouchers',
      entityId: id,
      metadata: {
        programmeId: voucher.programmeId,
        refundedAmountKobo: refundedKobo,
        complaintCaseId: voucher.complaintCaseId,
        reason: voucher.refundReason
      }
    });
    return refunded;
  }

  /**
   * ISSUED/PARTIALLY_REDEEMED→EXPIRING→EXPIRED for a voucher past its expiry
   * (admin-triggered sweep step). W2-C2 (V-32): a partially redeemed voucher
   * expires its REMAINING balance — committed parts stay settled.
   */
  async expireVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    const voucher = await this.getVoucher(id);
    if (voucher.status !== 'ISSUED' && voucher.status !== 'EXPIRING' && voucher.status !== 'PARTIALLY_REDEEMED') {
      throw new ConflictException(
        `Only ISSUED or PARTIALLY_REDEEMED vouchers can expire (status is ${voucher.status})`
      );
    }
    if (Date.parse(voucher.expiresAt) > Date.now()) {
      throw new BadRequestException(`Voucher '${id}' has not expired yet (expires ${voucher.expiresAt})`);
    }
    return this.expireIssuedVoucher(voucher, actorId);
  }

  /**
   * Releases the encumbrance through the EXPIRING pending state (stage 22,
   * audit C1-6): CAS ISSUED→EXPIRING FIRST so only the claimant posts the
   * release entry, then finalize EXPIRING→EXPIRED. The release posting is
   * idempotent on input-voucher-release:<id>, so a retry that finds EXPIRING
   * resumes finalization instead of double-releasing; on posting failure the
   * claim rolls back EXPIRING→ISSUED only with proof that no release entry
   * exists (stage 24, audit A4-1) — otherwise EXPIRING stays for resume.
   */
  private async expireIssuedVoucher(voucher: InputVoucherRecord, actorId: string): Promise<InputVoucherRecord> {
    // Stage 24 (audit A1-3): never release on top of a committed redemption
    // posting whose finalize never landed (crash window) — the release would
    // debit the liability on top of the redemption posting.
    await this.assertNoRedemptionPosting(voucher);
    // W2-C2 (V-32): expiry releases the REMAINING balance only; committed
    // redemption parts were already settled by their own postings.
    const remainingKobo = voucher.amountKobo - (voucher.redeemedAmountKobo ?? 0);
    if (voucher.status === 'ISSUED' || voucher.status === 'PARTIALLY_REDEEMED') {
      await this.vouchers.updateExpected(voucher.id, { status: 'EXPIRING' }, { status: voucher.status });
    }
    try {
      if (remainingKobo > 0) {
        await this.releaseEncumbrance(voucher, actorId, 'expiry', remainingKobo);
        // Release the float reservation exactly once (stage 23, audit C3) —
        // marker-keyed so a retry resuming EXPIRING never double-releases.
        await this.funding.releaseReserved(
          voucher.programmeId,
          remainingKobo,
          `input-voucher-funding-release:${voucher.id}`,
          actorId
        );
      }
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
    const updated = await this.vouchers.updateExpected(
      voucher.id,
      { status: 'EXPIRED' },
      { status: 'EXPIRING' }
    );
    await this.events.publish(
      'inputvouchers.voucher.expired',
      { voucherId: voucher.id, programmeId: voucher.programmeId },
      actorId
    );
    return updated;
  }

  /**
   * Releases the encumbrance: DR programme liability / CR platform budget
   * expense. W2-C2 (V-32/V-02): the release amount is explicit — expiry of a
   * partially redeemed voucher (or the refund of one) releases only the
   * REMAINING balance; void releases the full face value.
   */
  private async releaseEncumbrance(
    voucher: InputVoucherRecord,
    actorId: string,
    reason: 'void' | 'expiry' | 'refund',
    amountKobo: number
  ): Promise<void> {
    const programme = await this.getProgramme(voucher.programmeId);
    await this.ledger.ensureAccount({ code: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, type: 'expense' });
    await this.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-release:${voucher.id}`,
        referenceType: `input_voucher_${reason}_release`,
        referenceId: voucher.id,
        description: `Subsidy encumbrance release (${reason}) for voucher ${voucher.id} (${amountKobo} kobo)`,
        postings: [
          { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo },
          { accountCode: PLATFORM_SUBSIDY_BUDGET_ACCOUNT, direction: 'credit', amountKobo }
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
      // W2-C2 (V-32): the rollback target preserves committed redemption
      // parts — a voucher with redeemed balance returns to
      // PARTIALLY_REDEEMED, not ISSUED, and the in-flight claim amount is
      // cleared so the next attempt reclaims from the stored balance.
      const current = await this.vouchers.findById(voucherId).catch(() => undefined);
      const rollbackTo =
        pending === 'VOIDING' || (current?.redeemedAmountKobo ?? 0) === 0 ? 'ISSUED' : 'PARTIALLY_REDEEMED';
      await this.vouchers
        .updateExpected(voucherId, { status: rollbackTo, pendingAmountKobo: undefined }, { status: pending })
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
    // W2-C2 (V-32): committed parts are accounted in redeemed_amount_kobo and
    // excluded from the release amount; the guard probes only the IN-FLIGHT
    // part (a committed posting whose finalize never landed).
    const { key } = await this.nextRedemptionPart(voucher);
    const redemption = await this.probeLedgerEntry(key);
    if (redemption.state !== 'found') {
      return;
    }
    if (voucher.status === 'VOIDING' || voucher.status === 'EXPIRING') {
      const release = await this.probeLedgerEntry(`input-voucher-release:${voucher.id}`);
      if (release.state === 'absent') {
        // W2-C2 (V-32): hand the stale claim back to the state its committed
        // parts imply — PARTIALLY_REDEEMED when a balance was already
        // redeemed, ISSUED otherwise.
        await this.vouchers
          .updateExpected(
            voucher.id,
            {
              status: (voucher.redeemedAmountKobo ?? 0) > 0 ? 'PARTIALLY_REDEEMED' : 'ISSUED',
              pendingAmountKobo: undefined
            },
            { status: voucher.status }
          )
          .catch(() => undefined);
      }
    }
    throw new ConflictException(
      `Voucher '${voucher.id}' already has a redemption posting in the ledger — it cannot be released; a redeem retry settles it`
    );
  }

  // ---------------------------------------------------------- reconciliation

  /**
   * Settlement reconciliation for regulators/donors: operational totals by
   * programme and beneficiary state, cross-checked against the ledger. The
   * double-entry tie is asserted as
   *   liability balance == budget - redeemed + refunded - released
   *     (redeemed = Σ redemption PARTS, V-32; refunded = reversal credits
   *     returning money to the envelope, V-02; released = never-redeemed
   *     remainders of expired/voided/refunded vouchers)
   * and a non-zero discrepancy flags an integrity breach loudly.
   */
  async reconciliation(programmeId: string): Promise<ProgrammeReconciliation> {
    const programme = await this.getProgramme(programmeId);
    const all = await this.vouchers.find({ programmeId });
    const redemptions = await this.redemptions.find({ programmeId });
    const beneficiaries = await this.beneficiaries.find({ programmeId });
    const stateOf = new Map(beneficiaries.map((item) => [item.farmerId, item.state ?? 'unspecified']));

    const sum = (rows: InputVoucherRecord[]) => rows.reduce((acc, row) => acc + row.amountKobo, 0);
    const outstanding = all.filter(
      (voucher) => voucher.status === 'ISSUED' || voucher.status === 'PARTIALLY_REDEEMED'
    );
    const redeemed = all.filter((voucher) => voucher.status === 'REDEEMED');
    const refunded = all.filter((voucher) => voucher.status === 'REFUNDED');
    const expired = all.filter((voucher) => voucher.status === 'EXPIRED');
    const voided = all.filter((voucher) => voucher.status === 'VOIDED');
    // W2-C2 (V-32): redemption parts, not vouchers — redeemedKobo sums ALL
    // part rows; a PARTIALLY_REDEEMED voucher contributes its redeemed share.
    const redeemedKobo = redemptions.reduce((acc, row) => acc + row.amountKobo, 0);
    const redeemedByVoucher = new Map<string, number>();
    for (const row of redemptions) {
      redeemedByVoucher.set(row.voucherId, (redeemedByVoucher.get(row.voucherId) ?? 0) + row.amountKobo);
    }
    // W2-C2 (V-02): refund reversals credit the liability back, so refunded
    // money re-joins the expected liability; releases on terminal vouchers
    // cover only the NEVER-redeemed remainder (expired/voided full face on
    // untouched vouchers, remaining balance on partial ones, zero on fully
    // refunded ones).
    const refundedKobo = refunded.reduce((acc, row) => acc + (row.refundedAmountKobo ?? 0), 0);
    // Expired/voided vouchers release their never-redeemed remainder; a
    // REFUNDED voucher releases its FULL face (the reversal restored the
    // redeemed parts to the liability first, then the whole encumbrance is
    // released to the budget).
    const releasedKobo =
      [...expired, ...voided].reduce(
        (acc, row) => acc + (row.amountKobo - (redeemedByVoucher.get(row.id) ?? 0)),
        0
      ) + sum(refunded);

    const byStateMap = new Map<string, ProgrammeStateTotals>();
    for (const voucher of all) {
      const state = stateOf.get(voucher.farmerId) ?? 'unspecified';
      const row = byStateMap.get(state) ?? { state, vouchersIssued: 0, outstandingKobo: 0, redeemedKobo: 0 };
      row.vouchersIssued += 1;
      if (voucher.status === 'ISSUED' || voucher.status === 'PARTIALLY_REDEEMED') {
        row.outstandingKobo += voucher.amountKobo - (redeemedByVoucher.get(voucher.id) ?? 0);
      }
      row.redeemedKobo += redeemedByVoucher.get(voucher.id) ?? 0;
      byStateMap.set(state, row);
    }

    const balance = await this.ledger.balance(programme.liabilityAccountCode);
    const liabilityKobo = balance.creditsKobo - balance.debitsKobo;
    // Double-entry tie: liability == budget - redeemed + refunded - released.
    const expectedLiabilityKobo = programme.budgetKobo - redeemedKobo + refundedKobo - releasedKobo;
    const funding = await this.funding.getFunding(programmeId);
    // Stage 27 (Insurance-in-the-Bag): bundled-cover tie — the insurer
    // premium payable balance must equal the sum of bound cover premiums
    // (mirrors the liability tie above; non-zero discrepancy = breach).
    let insurance: ProgrammeReconciliation['insurance'];
    if (this.covers) {
      const programmeCovers = await this.covers.find({ programmeId });
      const premiumKobo = programmeCovers.reduce((acc, cover) => acc + cover.premiumKobo, 0);
      const premiumAccount = programmeInsurancePremiumAccountCode(programmeId);
      // Provision the account up-front so the balance read ties to zero for
      // programmes that never bound a cover (same pattern as the liability
      // account provisioning at programme creation).
      await this.ledger.ensureAccount({ code: premiumAccount, type: 'liability' });
      const premiumBalance = await this.ledger.balance(premiumAccount);
      const premiumPayableKobo = premiumBalance.creditsKobo - premiumBalance.debitsKobo;
      insurance = {
        premiumPayableAccountCode: premiumAccount,
        coversBound: programmeCovers.length,
        premiumKobo,
        premiumPayableKobo,
        discrepancyKobo: premiumPayableKobo - premiumKobo
      };
    }
    return {
      programmeId,
      budgetKobo: programme.budgetKobo,
      totals: {
        vouchersIssued: all.length,
        allocatedKobo: sum(all),
        outstandingCount: outstanding.length,
        outstandingKobo: outstanding.reduce(
          (acc, row) => acc + (row.amountKobo - (redeemedByVoucher.get(row.id) ?? 0)),
          0
        ),
        redeemedCount: redeemed.length,
        redeemedKobo,
        refundedCount: refunded.length,
        refundedKobo,
        expiredCount: expired.length,
        expiredKobo: expired.reduce(
          (acc, row) => acc + (row.amountKobo - (redeemedByVoucher.get(row.id) ?? 0)),
          0
        ),
        voidedCount: voided.length,
        voidedKobo: sum(voided),
        beneficiariesVerified: beneficiaries.length
      },
      byState: [...byStateMap.values()].sort((a, b) => a.state.localeCompare(b.state)),
      ledger: {
        liabilityAccountCode: programme.liabilityAccountCode,
        liabilityKobo,
        expectedLiabilityKobo,
        discrepancyKobo: liabilityKobo - expectedLiabilityKobo
      },
      funding: this.toFundingView(funding, programmeId),
      ...(insurance ? { insurance } : {}),
      generatedAt: new Date().toISOString()
    };
  }

  /** Identity adapter diagnostics — honestly labelled driver + config state. */
  identityStatus(): { driver: 'stub' | 'live'; configured: boolean; detail: string } {
    if (this.identity.name === 'stub') {
      return {
        driver: 'stub',
        configured: true,
        detail:
          'Deterministic STUB identity driver (hash-derived, clearly labelled). NOT a real NIN check — ' +
          'live verification is gated on a NIMC/licensed vendor contract.'
      };
    }
    return {
      driver: 'live',
      configured: false,
      detail: 'Live NIN identity driver reserved — vendor client not integrated (fail-closed 503).'
    };
  }

  /** Caller must be the farmer themself or an admin/regulator/donor. */
  assertFarmerStatementAccess(farmerId: string, actor: ActorRef): void {
    if (
      actor.id !== farmerId &&
      !actor.roles.includes('admin') &&
      !actor.roles.includes('regulator') &&
      !actor.roles.includes('donor')
    ) {
      throw new ForbiddenException('Only the farmer or an authorised reviewer can access these vouchers');
    }
  }
}
