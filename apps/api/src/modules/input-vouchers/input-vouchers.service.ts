import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  BENEFICIARY_REPOSITORY,
  INPUT_VOUCHER_PROGRAMME_REPOSITORY,
  INPUT_VOUCHER_REDEMPTION_REPOSITORY,
  INPUT_VOUCHER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  BeneficiaryRecord,
  BeneficiaryRepository,
  InputVoucherRecord,
  InputVoucherRepository,
  ProgrammeStatus,
  RedemptionRecord,
  RedemptionRepository,
  SubsidyProgrammeRecord,
  SubsidyProgrammeRepository
} from '../../database/repositories/input-vouchers.repository.js';
import { LedgerService } from '../finance/ledger.service.js';
import { UsersService } from '../users/users.service.js';
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
  generatedAt: string;
}

export const DEFAULT_VOUCHER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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
 * Identity: allocation requires a beneficiary verified through the fail-closed
 * IdentityVerificationPort (stub default, honestly labelled). The plaintext
 * NIN is never persisted — salted HMAC hash + last-3 mask only.
 */
@Injectable()
export class InputVouchersService {
  private readonly ninSalt: string;

  constructor(
    @Inject(INPUT_VOUCHER_PROGRAMME_REPOSITORY) private readonly programmes: SubsidyProgrammeRepository,
    @Inject(BENEFICIARY_REPOSITORY) private readonly beneficiaries: BeneficiaryRepository,
    @Inject(INPUT_VOUCHER_REPOSITORY) private readonly vouchers: InputVoucherRepository,
    @Inject(INPUT_VOUCHER_REDEMPTION_REPOSITORY) private readonly redemptions: RedemptionRepository,
    private readonly ledger: LedgerService,
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    @Inject(IDENTITY_VERIFICATION_PORT) private readonly identity: IdentityVerificationPort,
    @Optional() private readonly audit?: AuditService,
    @Optional() env: NodeJS.ProcessEnv = process.env
  ) {
    this.ninSalt = resolveNinHashSalt(env);
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
   * state/crop, per-farmer cap and the remaining budget envelope.
   */
  async allocateVoucher(
    programmeId: string,
    input: AllocateVoucherInput,
    actorId: string
  ): Promise<InputVoucherRecord> {
    const replay = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
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
    // Allocation rules: live obligations (ISSUED + REDEEMED) count against the
    // per-farmer cap and the budget envelope; EXPIRED/VOIDED released them.
    const live = (await this.vouchers.find({ programmeId })).filter(
      (voucher) => voucher.status === 'ISSUED' || voucher.status === 'REDEEMED'
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
    try {
      const record = await this.vouchers.create({
        id: newId('ivc'),
        programmeId,
        beneficiaryId: beneficiary.id,
        farmerId: input.farmerId,
        amountKobo: input.amountKobo,
        status: 'ISSUED',
        idempotencyKey: input.idempotencyKey,
        expiresAt,
        createdAt: new Date().toISOString()
      });
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
    } catch (error) {
      if (error instanceof ConflictException) {
        // Lost a retry race — the original record is authoritative.
        const existing = await this.vouchers.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          return existing;
        }
      }
      throw error;
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
   * reference. Anti-double-spend: the ledger posting is idempotent on
   * input-voucher-redemption:<id>, the redemption row carries UNIQUE
   * voucher_id, and the state machine CAS ISSUED→REDEEMED makes a second
   * redemption a 409 — a voucher pays out exactly once.
   */
  async redeemVoucher(
    id: string,
    invoiceRef: string,
    actor: ActorRef
  ): Promise<{ voucher: InputVoucherRecord; redemption: RedemptionRecord }> {
    if (!invoiceRef?.trim()) {
      throw new BadRequestException('invoiceRef is required — redemptions settle against a dealer invoice');
    }
    const voucher = await this.getVoucher(id);
    if (voucher.status === 'REDEEMED') {
      throw new ConflictException(`Voucher '${id}' has already been redeemed`);
    }
    if (voucher.status === 'VOIDED') {
      throw new ConflictException(`Voucher '${id}' was voided`);
    }
    if (voucher.status === 'EXPIRED' || Date.parse(voucher.expiresAt) <= Date.now()) {
      if (voucher.status === 'ISSUED') {
        await this.expireIssuedVoucher(voucher, actor.id);
      }
      throw new GoneException(`Voucher '${id}' expired at ${voucher.expiresAt}`);
    }
    if (!voucher.distributedAt) {
      throw new BadRequestException(`Voucher '${id}' has not been distributed to the farmer yet`);
    }
    const replay = await this.redemptions.findByIdempotencyKey(`input-voucher-redemption:${voucher.id}`);
    if (replay) {
      // Ledger posting already landed; return the settled view.
      return { voucher: await this.getVoucher(id), redemption: replay };
    }
    const programme = await this.getProgramme(voucher.programmeId);
    await this.ledger.ensureAccount({
      code: supplierReceivableAccountCode(actor.id),
      type: 'liability',
      ownerId: actor.id
    });
    const entry = await this.ledger.postEntry(
      {
        idempotencyKey: `input-voucher-redemption:${voucher.id}`,
        referenceType: 'input_voucher_redemption',
        referenceId: voucher.id,
        description: `Subsidy voucher ${voucher.id} redeemed by supplier ${actor.id} (invoice ${invoiceRef.trim()})`,
        postings: [
          { accountCode: programme.liabilityAccountCode, direction: 'debit', amountKobo: voucher.amountKobo },
          { accountCode: supplierReceivableAccountCode(actor.id), direction: 'credit', amountKobo: voucher.amountKobo }
        ]
      },
      actor.id
    );
    // Atomic state advance: a concurrent redemption that already flipped the
    // voucher surfaces as a 409 (its ledger posting replayed via the key).
    const redeemed = await this.vouchers.updateExpected(
      id,
      { status: 'REDEEMED', redeemedAt: new Date().toISOString(), ledgerEntryId: entry.id },
      { status: 'ISSUED' }
    );
    const redemption = await this.redemptions.create({
      id: newId('ired'),
      voucherId: voucher.id,
      programmeId: voucher.programmeId,
      supplierId: actor.id,
      invoiceRef: invoiceRef.trim(),
      amountKobo: voucher.amountKobo,
      idempotencyKey: `input-voucher-redemption:${voucher.id}`,
      ledgerEntryId: entry.id,
      createdAt: new Date().toISOString()
    });
    await this.events.publish(
      'inputvouchers.voucher.redeemed',
      {
        voucherId: voucher.id,
        programmeId: voucher.programmeId,
        farmerId: voucher.farmerId,
        supplierId: actor.id,
        amountKobo: voucher.amountKobo
      },
      actor.id
    );
    await this.audit?.record({
      actorId: actor.id,
      action: 'inputvouchers.voucher.redeemed',
      entityType: 'input_vouchers_vouchers',
      entityId: voucher.id,
      metadata: { programmeId: voucher.programmeId, amountKobo: voucher.amountKobo, invoiceRef: invoiceRef.trim() }
    });
    return { voucher: redeemed, redemption };
  }

  /** ISSUED→VOIDED (admin) with encumbrance release back to the budget expense. */
  async voidVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    const voucher = await this.getVoucher(id);
    if (voucher.status !== 'ISSUED') {
      throw new ConflictException(`Only ISSUED vouchers can be voided (status is ${voucher.status})`);
    }
    await this.releaseEncumbrance(voucher, actorId, 'void');
    const updated = await this.vouchers.updateExpected(
      id,
      { status: 'VOIDED', voidedAt: new Date().toISOString() },
      { status: 'ISSUED' }
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

  /** ISSUED→EXPIRED for a voucher past its expiry (admin-triggered sweep step). */
  async expireVoucher(id: string, actorId: string): Promise<InputVoucherRecord> {
    const voucher = await this.getVoucher(id);
    if (voucher.status !== 'ISSUED') {
      throw new ConflictException(`Only ISSUED vouchers can expire (status is ${voucher.status})`);
    }
    if (Date.parse(voucher.expiresAt) > Date.now()) {
      throw new BadRequestException(`Voucher '${id}' has not expired yet (expires ${voucher.expiresAt})`);
    }
    return this.expireIssuedVoucher(voucher, actorId);
  }

  private async expireIssuedVoucher(voucher: InputVoucherRecord, actorId: string): Promise<InputVoucherRecord> {
    await this.releaseEncumbrance(voucher, actorId, 'expiry');
    const updated = await this.vouchers.updateExpected(
      voucher.id,
      { status: 'EXPIRED' },
      { status: 'ISSUED' }
    );
    await this.events.publish(
      'inputvouchers.voucher.expired',
      { voucherId: voucher.id, programmeId: voucher.programmeId },
      actorId
    );
    return updated;
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

  // ---------------------------------------------------------- reconciliation

  /**
   * Settlement reconciliation for regulators/donors: operational totals by
   * programme and beneficiary state, cross-checked against the ledger. The
   * double-entry tie is asserted as
   *   liability balance == budget - redeemed - released (expired + voided)
   * and a non-zero discrepancy flags an integrity breach loudly.
   */
  async reconciliation(programmeId: string): Promise<ProgrammeReconciliation> {
    const programme = await this.getProgramme(programmeId);
    const all = await this.vouchers.find({ programmeId });
    const redemptions = await this.redemptions.find({ programmeId });
    const beneficiaries = await this.beneficiaries.find({ programmeId });
    const stateOf = new Map(beneficiaries.map((item) => [item.farmerId, item.state ?? 'unspecified']));

    const sum = (rows: InputVoucherRecord[]) => rows.reduce((acc, row) => acc + row.amountKobo, 0);
    const outstanding = all.filter((voucher) => voucher.status === 'ISSUED');
    const redeemed = all.filter((voucher) => voucher.status === 'REDEEMED');
    const expired = all.filter((voucher) => voucher.status === 'EXPIRED');
    const voided = all.filter((voucher) => voucher.status === 'VOIDED');
    const redeemedKobo = redemptions.reduce((acc, row) => acc + row.amountKobo, 0);
    const releasedKobo = sum(expired) + sum(voided);

    const byStateMap = new Map<string, ProgrammeStateTotals>();
    for (const voucher of all) {
      const state = stateOf.get(voucher.farmerId) ?? 'unspecified';
      const row = byStateMap.get(state) ?? { state, vouchersIssued: 0, outstandingKobo: 0, redeemedKobo: 0 };
      row.vouchersIssued += 1;
      if (voucher.status === 'ISSUED') {
        row.outstandingKobo += voucher.amountKobo;
      }
      if (voucher.status === 'REDEEMED') {
        row.redeemedKobo += voucher.amountKobo;
      }
      byStateMap.set(state, row);
    }

    const balance = await this.ledger.balance(programme.liabilityAccountCode);
    const liabilityKobo = balance.creditsKobo - balance.debitsKobo;
    const expectedLiabilityKobo = programme.budgetKobo - redeemedKobo - releasedKobo;
    return {
      programmeId,
      budgetKobo: programme.budgetKobo,
      totals: {
        vouchersIssued: all.length,
        allocatedKobo: sum(all),
        outstandingCount: outstanding.length,
        outstandingKobo: sum(outstanding),
        redeemedCount: redeemed.length,
        redeemedKobo,
        expiredCount: expired.length,
        expiredKobo: sum(expired),
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
