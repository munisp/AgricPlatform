import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  Animal,
  AnimalHealthRecord,
  AnimalMovement,
  InsurancePolicy,
  LivestockLien,
  MovementPermit,
  OwnershipTransfer,
  User,
  UserRole
} from '@agric-platform/shared';
import { VACCINATION_SCHEDULES } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { isProduction } from '../../common/auth/auth.config.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  HEALTH_RECORD_REPOSITORY,
  INSURANCE_POLICY_REPOSITORY,
  LIEN_REPOSITORY,
  LIVESTOCK_PASSPORT_EVENT_REPOSITORY,
  LIVESTOCK_PASSPORT_REPOSITORY,
  LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY,
  MOVEMENT_PERMIT_REPOSITORY,
  MOVEMENT_REPOSITORY,
  OWNERSHIP_TRANSFER_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  OwnershipTransferRepository
} from '../../database/repositories/livestock.repository.js';
import type {
  HealthRecordRepository,
  MovementPermitRepository,
  MovementRepository
} from '../../database/repositories/livestock-health.repository.js';
import type {
  InsurancePolicyRepository,
  LienRepository
} from '../../database/repositories/livestock-trade.repository.js';
import type {
  LivestockPassportRepository,
  PassportEventRepository,
  PassportTransferRepository
} from '../../database/repositories/livestock-passport.repository.js';
import { UsersService } from '../users/users.service.js';
import {
  ANIMAL_ID_AUTHORITY_PROVIDER,
  type AnimalIdAuthorityProvider
} from './animal-id-authority.provider.js';
import {
  formatPassportCode,
  parsePassportCode,
  resolvePassportCodeSecret,
  signPassportCode,
  verifyPassportCode
} from './passport-code.js';
import {
  computePassportEventHash,
  GENESIS_PREV_HASH,
  passportHashPayloadOf,
  verifyPassportChain,
  type LivestockPassport,
  type PassportChainVerification,
  type PassportEvent,
  type PassportEventType,
  type PassportTransfer,
  type TagCheckBasis
} from './passport.types.js';

export interface IssuePassportInput {
  animalId: string;
}

export interface InitiateTransferInput {
  toUserId: string;
  note?: string;
}

/** Composite passport document — identity + aggregated domain history. */
export interface PassportDocument {
  passport: LivestockPassport;
  animal: Animal;
  owner: { userId: string; fullName: string };
  healthRecords: AnimalHealthRecord[];
  vaccinationSummary: VaccinationSummary;
  movements: AnimalMovement[];
  movementSummary: MovementLegalitySummary;
  liens: LivestockLien[];
  activeLien?: LivestockLien;
  insurancePolicies: InsurancePolicy[];
  ownershipTransfers: OwnershipTransfer[];
  passportTransfers: PassportTransfer[];
  chain: PassportChainVerification;
}

export interface VaccinationSummary {
  requiredVaccinations: readonly string[];
  completedVaccinations: string[];
  /** Fraction of the species schedule covered (0..1), reversal-aware. */
  coverage: number;
  vaccinationCount: number;
  treatmentCount: number;
  /** True while any treatment withdrawal window is still running (food-safety hold). */
  activeWithdrawal: boolean;
  lastVaccinationAt?: string;
}

export interface MovementLegalitySummary {
  totalMovements: number;
  movementsWithPermit: number;
  openMovements: number;
  revokedPermits: number;
  /** Every logged movement was covered by a permit that was never revoked. */
  legal: boolean;
}

/** Redacted public verification view — NO owner PII beyond initials. */
export interface PublicPassportVerification {
  verified: true;
  passportCode: string;
  passportStatus: LivestockPassport['status'];
  animal: {
    id: string;
    species: Animal['species'];
    breed: string;
    sex: Animal['sex'];
    birthDate?: string;
    state: string;
    status: Animal['status'];
  };
  /** Owner identity redacted to initials only (e.g. "A.B."). */
  ownerInitials: string;
  vaccinationSummary: {
    requiredVaccinations: readonly string[];
    completedVaccinations: string[];
    coverage: number;
    activeWithdrawal: boolean;
  };
  movementLegality: {
    totalMovements: number;
    movementsWithPermit: number;
    legal: boolean;
  };
  encumbrance: {
    /** A buyer-relevant flag only — lien amounts/lender identity stay private. */
    activeLien: boolean;
    insured: boolean;
  };
  tagCheck: {
    basis: TagCheckBasis;
    /** Stub basis is always surfaced honestly — no registry was contacted. */
    stub: boolean;
  };
  chain: {
    eventCount: number;
    valid: boolean;
    headHash?: string;
  };
  /** QR-code-ready payload: encode `verifyPath` (or an absolute URL of it). */
  qr: {
    code: string;
    verifyPath: string;
  };
  disclaimers: string[];
}

export interface OversightExportRow {
  passportId: string;
  animalId: string;
  species: Animal['species'];
  state: string;
  ownerUserId: string;
  status: LivestockPassport['status'];
  tagCheckBasis: TagCheckBasis;
  vaccinationCoverage: number;
  activeLien: boolean;
  pendingTransfer: boolean;
  chainValid: boolean;
  eventCount: number;
  createdAt: string;
}

const PRIVILEGED_READERS: readonly UserRole[] = ['admin', 'vet', 'regulator'];

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for livestock passports');
  }
  return actor;
}

function hasAnyRole(actor: User, roles: readonly UserRole[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}

/** Redacts a full name to initials ("Adamu Bello" → "A.B."). */
export function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '—';
  }
  return `${parts.map((part) => part[0]!.toUpperCase()).join('.')}.`;
}

/**
 * Digital livestock passport (wave-livestock-passport, innovation #9). The
 * passport AGGREGATES the existing livestock domain — animal identity
 * (wave L1a), vet-signed health records + movement permits (wave L1b),
 * liens + animal insurance (wave L1c) — into a single verifiable identity
 * document per animal. It does not rebuild those domains: every history
 * section is read through the existing repositories at compose time, and
 * confirmed ownership transfers execute through the livestock core
 * AnimalRepository.transferOwnership path (single ownership ledger). The
 * passport's own lifecycle is an append-only hash-chained event log
 * (traceability pattern) so the document is tamper-evident.
 *
 * ⚖ The active-lien transfer block reuses the livestock-trade lien ledger;
 * the same legal-activation caveat as LiensService applies (secured
 * transactions in movable assets — see docs/livestock-passport.md).
 */
@Injectable()
export class LivestockPassportService {
  private readonly codeSecret: string;

  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    @Inject(ANIMAL_ID_AUTHORITY_PROVIDER)
    private readonly authority: AnimalIdAuthorityProvider,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(OWNERSHIP_TRANSFER_REPOSITORY)
    private readonly ownershipTransfers: OwnershipTransferRepository,
    @Inject(HEALTH_RECORD_REPOSITORY) private readonly healthRecords: HealthRecordRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(MOVEMENT_PERMIT_REPOSITORY) private readonly permits: MovementPermitRepository,
    @Inject(LIEN_REPOSITORY) private readonly liens: LienRepository,
    @Inject(INSURANCE_POLICY_REPOSITORY) private readonly policies: InsurancePolicyRepository,
    @Inject(LIVESTOCK_PASSPORT_REPOSITORY)
    private readonly passports: LivestockPassportRepository,
    @Inject(LIVESTOCK_PASSPORT_EVENT_REPOSITORY)
    private readonly passportEvents: PassportEventRepository,
    @Inject(LIVESTOCK_PASSPORT_TRANSFER_REPOSITORY)
    private readonly passportTransfers: PassportTransferRepository
  ) {
    this.codeSecret = resolvePassportCodeSecret();
  }

  /* ------------------------------ issuance ------------------------------ */

  /**
   * Issues the passport for a registered animal (owner or admin). One
   * passport per animal. When the animal carries a tag/eid, the external
   * animal-ID authority port is consulted and the honest basis label is
   * stored; a configured-but-unreachable live authority fails closed (503)
   * instead of silently stamping a stub verdict.
   */
  async issuePassport(actor: User | null, input: IssuePassportInput): Promise<PassportDocument> {
    const caller = requireActor(actor);
    const animal = await this.animals.getById(input.animalId);
    if (animal.ownerUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('You may only issue passports for your own animals');
    }
    const existing = await this.passports.findByAnimalId(animal.id);
    if (existing) {
      throw new ConflictException(
        `Animal '${animal.id}' already has a livestock passport ('${existing.id}')`
      );
    }

    let tagCheckBasis: TagCheckBasis = 'none';
    let tagCheckDetail: string | undefined;
    if (animal.tagId || animal.eid) {
      try {
        const check = await this.authority.checkTag({
          animalId: animal.id,
          species: animal.species,
          state: animal.state,
          tagId: animal.tagId,
          eid: animal.eid
        });
        // Fail closed (mirrors the warehouse deposit/pledge basis guards): a
        // stub tag verdict is a deterministic fabrication — stamping it on a
        // passport in production would certify livestock identity against no
        // real registry. Refuse issuance instead.
        if (isProduction() && check.basis !== 'live') {
          throw new ServiceUnavailableException(
            'The animal-ID authority check did not come from the live registry (basis is not live). ' +
              'Refusing passport issuance in production — configure ANIMAL_ID_AUTHORITY_MODE=live ' +
              'with ANIMAL_ID_AUTHORITY_URL and ANIMAL_ID_AUTHORITY_API_KEY.'
          );
        }
        tagCheckBasis = check.basis;
        tagCheckDetail = check.detail;
      } catch (error) {
        // Fail closed: a configured live authority that cannot be reached
        // must not be silently replaced by a fabricated or stub verdict.
        throw new ServiceUnavailableException(
          `The configured animal-ID authority is unreachable (${(error as Error).message}); passport issuance was aborted rather than recorded without the registry check.`
        );
      }
    }

    const now = new Date().toISOString();
    const id = newId('lsp');
    const nonce = randomBytes(4).toString('hex');
    const signature = signPassportCode({ passportId: id, animalId: animal.id, nonce }, this.codeSecret);
    const passport: LivestockPassport = {
      id,
      animalId: animal.id,
      passportCode: formatPassportCode(animal.id, nonce, signature),
      codeNonce: nonce,
      codeSignature: signature,
      ownerUserId: animal.ownerUserId,
      status: 'active',
      tagCheckBasis,
      tagCheckDetail,
      issuedBy: caller.id,
      createdAt: now,
      updatedAt: now
    };
    await this.passports.create(passport);
    await this.appendEvent(passport, 'ISSUED', caller.id, {
      animalId: animal.id,
      species: animal.species,
      state: animal.state,
      tagCheckBasis
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_passport.passport_issued',
      entityType: 'livestock_passport',
      entityId: passport.id,
      metadata: { animalId: animal.id, tagCheckBasis }
    });
    await this.events.publish(
      'livestock_passport.passport.issued',
      { passportId: passport.id, animalId: animal.id, ownerUserId: animal.ownerUserId },
      caller.id
    );
    return this.compose(passport);
  }

  /* ------------------------------- reads -------------------------------- */

  /** Passports for animals the caller currently owns. */
  async listMine(actor: User | null): Promise<PassportDocument[]> {
    const caller = requireActor(actor);
    const passports = await this.passports.find({ ownerUserId: caller.id });
    return Promise.all(passports.map((passport) => this.compose(passport)));
  }

  /** Full composite document. Owner, privileged readers, or the buyer named on a pending transfer. */
  async getPassport(actor: User | null, passportId: string): Promise<PassportDocument> {
    const caller = requireActor(actor);
    const passport = await this.passports.getById(passportId);
    await this.assertReadAccess(caller, passport);
    return this.compose(passport);
  }

  /** Hash-chained event log with recomputed verification. */
  async getEvents(
    actor: User | null,
    passportId: string
  ): Promise<{ passport: LivestockPassport; events: PassportEvent[]; verification: PassportChainVerification }> {
    const caller = requireActor(actor);
    const passport = await this.passports.getById(passportId);
    await this.assertReadAccess(caller, passport);
    const events = await this.passportEvents.listByPassport(passportId);
    return { passport, events, verification: verifyPassportChain(passportId, events) };
  }

  /* --------------------------- ownership transfer ------------------------ */

  /**
   * Seller initiates an ownership transfer. Blocked while an active lien
   * exists on the animal (livestock-trade lien ledger — the same guard the
   * livestock core consults), while the passport is not active, or while
   * another transfer is pending.
   */
  async initiateTransfer(
    actor: User | null,
    passportId: string,
    input: InitiateTransferInput
  ): Promise<PassportTransfer> {
    const caller = requireActor(actor);
    const passport = await this.passports.getById(passportId);
    const animal = await this.animals.getById(passport.animalId);
    if (animal.ownerUserId !== caller.id || passport.ownerUserId !== caller.id) {
      throw new ForbiddenException('Only the current owner can initiate an ownership transfer');
    }
    if (passport.status !== 'active') {
      throw new BadRequestException(`Passport '${passportId}' is ${passport.status}; transfers are locked`);
    }
    if (animal.status === 'dead') {
      throw new BadRequestException(`Animal '${animal.id}' is dead and cannot be transferred`);
    }
    if (input.toUserId === caller.id) {
      throw new BadRequestException('Cannot transfer an animal to yourself');
    }
    await this.users.getById(input.toUserId); // 404 for unknown buyers
    const activeLien = await this.liens.findActiveForSubject('animal', animal.id);
    if (activeLien) {
      throw new ConflictException(
        `Animal '${animal.id}' has an active lien ('${activeLien.id}') and cannot be transferred or sold`
      );
    }
    const now = new Date().toISOString();
    const transfer: PassportTransfer = {
      id: newId('lspt'),
      passportId: passport.id,
      animalId: animal.id,
      fromUserId: caller.id,
      toUserId: input.toUserId,
      status: 'pending',
      note: input.note,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.passportTransfers.create(transfer);
    await this.appendEvent(passport, 'TRANSFER_INITIATED', caller.id, {
      transferId: transfer.id,
      fromUserId: caller.id,
      toUserId: input.toUserId
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_passport.transfer_initiated',
      entityType: 'passport_transfer',
      entityId: transfer.id,
      metadata: { passportId: passport.id, animalId: animal.id, toUserId: input.toUserId }
    });
    await this.events.publish(
      'livestock_passport.transfer.initiated',
      {
        transferId: transfer.id,
        passportId: passport.id,
        animalId: animal.id,
        fromUserId: caller.id,
        toUserId: input.toUserId
      },
      caller.id
    );
    return transfer;
  }

  /**
   * Buyer confirms a pending transfer: executes the ownership change through
   * the livestock core ledger, moves the passport to the buyer and closes
   * the handshake. Both parties appear in the audit trail (initiation by the
   * seller, confirmation here by the buyer) and in the hash chain.
   */
  async confirmTransfer(actor: User | null, transferId: string): Promise<PassportTransfer> {
    const caller = requireActor(actor);
    const transfer = await this.passportTransfers.getById(transferId);
    if (transfer.toUserId !== caller.id) {
      throw new ForbiddenException('Only the named buyer can confirm this transfer');
    }
    if (transfer.status !== 'pending') {
      throw new BadRequestException(`Transfer '${transferId}' is ${transfer.status}`);
    }
    const passport = await this.passports.getById(transfer.passportId);
    if (passport.status !== 'active') {
      throw new BadRequestException(`Passport '${passport.id}' is ${passport.status}; transfers are locked`);
    }
    const animal = await this.animals.getById(transfer.animalId);
    if (animal.ownerUserId !== transfer.fromUserId) {
      throw new ConflictException(
        `Animal '${animal.id}' is no longer owned by the seller; this transfer is stale — cancel it`
      );
    }
    // Re-checked at confirmation: a lien registered after initiation still blocks.
    const activeLien = await this.liens.findActiveForSubject('animal', animal.id);
    if (activeLien) {
      throw new ConflictException(
        `Animal '${animal.id}' has an active lien ('${activeLien.id}') and cannot be transferred or sold`
      );
    }
    const now = new Date().toISOString();
    const executed: OwnershipTransfer = {
      id: newId('transfer'),
      animalId: animal.id,
      fromUserId: transfer.fromUserId,
      toUserId: caller.id,
      transferType: 'sale',
      effectiveAt: now,
      recordedBy: caller.id,
      createdAt: now
    };
    await this.animals.transferOwnership(executed);
    const updated = await this.passportTransfers.update(transferId, {
      status: 'confirmed',
      executedTransferId: executed.id,
      confirmedAt: now,
      updatedAt: now
    });
    await this.passports.update(passport.id, { ownerUserId: caller.id, updatedAt: now });
    await this.appendEvent(passport, 'TRANSFER_CONFIRMED', caller.id, {
      transferId: transfer.id,
      executedTransferId: executed.id,
      fromUserId: transfer.fromUserId,
      toUserId: caller.id
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_passport.transfer_confirmed',
      entityType: 'passport_transfer',
      entityId: transfer.id,
      metadata: {
        passportId: passport.id,
        animalId: animal.id,
        fromUserId: transfer.fromUserId,
        toUserId: caller.id,
        executedTransferId: executed.id
      }
    });
    await this.events.publish(
      'livestock_passport.transfer.confirmed',
      {
        transferId: transfer.id,
        passportId: passport.id,
        animalId: animal.id,
        fromUserId: transfer.fromUserId,
        toUserId: caller.id
      },
      caller.id
    );
    return updated;
  }

  /** Seller (or admin) cancels a pending transfer. */
  async cancelTransfer(actor: User | null, transferId: string): Promise<PassportTransfer> {
    const caller = requireActor(actor);
    const transfer = await this.passportTransfers.getById(transferId);
    if (transfer.fromUserId !== caller.id && !caller.roles.includes('admin')) {
      throw new ForbiddenException('Only the seller (or an admin) can cancel this transfer');
    }
    if (transfer.status !== 'pending') {
      throw new BadRequestException(`Transfer '${transferId}' is ${transfer.status}`);
    }
    const now = new Date().toISOString();
    const updated = await this.passportTransfers.update(transferId, {
      status: 'cancelled',
      cancelledAt: now,
      updatedAt: now
    });
    const passport = await this.passports.getById(transfer.passportId);
    await this.appendEvent(passport, 'TRANSFER_CANCELLED', caller.id, {
      transferId: transfer.id,
      fromUserId: transfer.fromUserId,
      toUserId: transfer.toUserId
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_passport.transfer_cancelled',
      entityType: 'passport_transfer',
      entityId: transfer.id,
      metadata: { passportId: transfer.passportId, animalId: transfer.animalId }
    });
    await this.events.publish(
      'livestock_passport.transfer.cancelled',
      { transferId: transfer.id, passportId: transfer.passportId, animalId: transfer.animalId },
      caller.id
    );
    return updated;
  }

  /** Transfers where the caller is the seller (outgoing) or buyer (incoming). */
  async listMyTransfers(
    actor: User | null,
    direction: 'incoming' | 'outgoing' = 'incoming'
  ): Promise<PassportTransfer[]> {
    const caller = requireActor(actor);
    return this.passportTransfers.find(
      direction === 'incoming' ? { toUserId: caller.id } : { fromUserId: caller.id }
    );
  }

  /* ------------------------- public verification ------------------------- */

  /**
   * UNAUTHENTICATED public verification (QR flow). The HMAC-signed code is
   * verified server-side; forged or malformed codes answer 404 (no oracle on
   * which part failed). The view is redacted: animal identity, vaccination
   * and movement-legality summaries, encumbrance flags — never owner PII
   * beyond initials, never lien amounts or lender identity.
   */
  async verifyPublic(passportCode: string): Promise<PublicPassportVerification> {
    const parsed = parsePassportCode(passportCode);
    if (!parsed) {
      throw new NotFoundException('Passport code is invalid or unknown');
    }
    const passport = await this.passports.findByCode(passportCode.trim());
    if (
      !passport ||
      passport.animalId !== parsed.animalId ||
      !verifyPassportCode(
        { passportId: passport.id, animalId: passport.animalId, nonce: passport.codeNonce },
        parsed.signaturePrefix,
        passport.codeSignature,
        this.codeSecret
      )
    ) {
      throw new NotFoundException('Passport code is invalid or unknown');
    }
    const document = await this.compose(passport);
    const owner = await this.users.getById(passport.ownerUserId);
    return {
      verified: true,
      passportCode: passport.passportCode,
      passportStatus: passport.status,
      animal: {
        id: document.animal.id,
        species: document.animal.species,
        breed: document.animal.breed,
        sex: document.animal.sex,
        birthDate: document.animal.birthDate,
        state: document.animal.state,
        status: document.animal.status
      },
      ownerInitials: initialsOf(owner.fullName),
      vaccinationSummary: {
        requiredVaccinations: document.vaccinationSummary.requiredVaccinations,
        completedVaccinations: document.vaccinationSummary.completedVaccinations,
        coverage: document.vaccinationSummary.coverage,
        activeWithdrawal: document.vaccinationSummary.activeWithdrawal
      },
      movementLegality: {
        totalMovements: document.movementSummary.totalMovements,
        movementsWithPermit: document.movementSummary.movementsWithPermit,
        legal: document.movementSummary.legal
      },
      encumbrance: {
        activeLien: Boolean(document.activeLien),
        insured: document.insurancePolicies.some((policy) => policy.status === 'bound')
      },
      tagCheck: {
        basis: passport.tagCheckBasis,
        stub: passport.tagCheckBasis === 'stub'
      },
      chain: {
        eventCount: document.chain.eventCount,
        valid: document.chain.valid,
        headHash: document.chain.headHash
      },
      qr: {
        code: passport.passportCode,
        verifyPath: `/api/v1/livestock-passport/verify/${encodeURIComponent(passport.passportCode)}`
      },
      disclaimers: [
        passport.tagCheckBasis === 'stub'
          ? 'Tag check basis is STUB: a deterministic simulation — no national animal-ID authority or RFID registry was contacted.'
          : 'Tag check basis reflects the configured animal-ID authority at issue time.',
        'This verification view is redacted: owner identity is initials-only and encumbrance is a flag, not financial detail.',
        'The digital passport aggregates platform records; it is not a government-issued document.'
      ]
    };
  }

  /* ------------------------- oversight & lifecycle ----------------------- */

  /** Regulator/admin oversight export: every passport with aggregate flags. */
  async oversightExport(actor: User | null): Promise<OversightExportRow[]> {
    const caller = requireActor(actor);
    if (!hasAnyRole(caller, ['regulator', 'admin'])) {
      throw new ForbiddenException('Only a regulator or admin can export passport oversight data');
    }
    const passports = await this.passports.find({});
    const rows: OversightExportRow[] = [];
    for (const passport of passports) {
      const document = await this.compose(passport);
      const pending = await this.passportTransfers.findPendingForPassport(passport.id);
      rows.push({
        passportId: passport.id,
        animalId: passport.animalId,
        species: document.animal.species,
        state: document.animal.state,
        ownerUserId: passport.ownerUserId,
        status: passport.status,
        tagCheckBasis: passport.tagCheckBasis,
        vaccinationCoverage: document.vaccinationSummary.coverage,
        activeLien: Boolean(document.activeLien),
        pendingTransfer: Boolean(pending),
        chainValid: document.chain.valid,
        eventCount: document.chain.eventCount,
        createdAt: passport.createdAt
      });
    }
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_passport.oversight_exported',
      entityType: 'livestock_passport',
      entityId: '*',
      metadata: { rowCount: rows.length }
    });
    return rows;
  }

  /** Admin/regulator suspension (fraud hold); revoked is terminal. */
  async suspend(actor: User | null, passportId: string): Promise<LivestockPassport> {
    return this.transitionStatus(actor, passportId, 'suspended', 'SUSPENDED');
  }

  async reinstate(actor: User | null, passportId: string): Promise<LivestockPassport> {
    return this.transitionStatus(actor, passportId, 'active', 'REINSTATED');
  }

  private async transitionStatus(
    actor: User | null,
    passportId: string,
    target: LivestockPassport['status'],
    eventType: PassportEventType
  ): Promise<LivestockPassport> {
    const caller = requireActor(actor);
    if (!hasAnyRole(caller, ['regulator', 'admin'])) {
      throw new ForbiddenException('Only a regulator or admin can change passport status');
    }
    const passport = await this.passports.getById(passportId);
    if (passport.status === 'revoked') {
      throw new BadRequestException(`Passport '${passportId}' is revoked; revoked is terminal`);
    }
    if (passport.status === target) {
      throw new BadRequestException(`Passport '${passportId}' is already ${target}`);
    }
    if (target === 'active' && passport.status !== 'suspended') {
      throw new BadRequestException(`Only a suspended passport can be reinstated`);
    }
    const updated = await this.passports.update(passportId, {
      status: target,
      updatedAt: new Date().toISOString()
    });
    await this.appendEvent(passport, eventType, caller.id, { from: passport.status, to: target });
    await this.audit.record({
      actorId: caller.id,
      action: `livestock_passport.passport_${eventType.toLowerCase()}`,
      entityType: 'livestock_passport',
      entityId: passportId,
      metadata: { from: passport.status, to: target }
    });
    await this.events.publish(
      `livestock_passport.passport.${eventType.toLowerCase()}`,
      { passportId, from: passport.status, to: target },
      caller.id
    );
    return updated;
  }

  /** External authority status (operator surfaces; honest stub labelling). */
  async authorityStatus(actor: User | null) {
    requireActor(actor);
    return this.authority.status();
  }

  /* ------------------------------ internals ------------------------------ */

  private async assertReadAccess(caller: User, passport: LivestockPassport): Promise<void> {
    if (caller.id === passport.ownerUserId || hasAnyRole(caller, PRIVILEGED_READERS)) {
      return;
    }
    // The buyer named on a pending transfer may inspect the document before
    // confirming — that is the point of the passport.
    const pending = await this.passportTransfers.findPendingForPassport(passport.id);
    if (pending && pending.toUserId === caller.id) {
      return;
    }
    throw new ForbiddenException('You may only access passports for your own animals');
  }

  /** Aggregates the existing livestock domain into the composite document. */
  private async compose(passport: LivestockPassport): Promise<PassportDocument> {
    const animal = await this.animals.getById(passport.animalId);
    const [healthRecords, movements, liens, policies, transfers, passportTransfers, chainEvents, owner] =
      await Promise.all([
        this.healthRecords.find({ animalId: animal.id }),
        this.movements.find({ animalId: animal.id }),
        this.liens.find({ subjectType: 'animal', subjectId: animal.id }),
        this.policies.find({ subjectType: 'animal', subjectId: animal.id }),
        this.ownershipTransfers.find({ animalId: animal.id }),
        this.passportTransfers.find({ passportId: passport.id }),
        this.passportEvents.listByPassport(passport.id),
        this.users.getById(passport.ownerUserId)
      ]);
    return {
      passport,
      animal,
      owner: { userId: owner.id, fullName: owner.fullName },
      healthRecords,
      vaccinationSummary: this.summarizeVaccinations(animal, healthRecords),
      movements,
      movementSummary: await this.summarizeMovements(movements),
      liens,
      activeLien: liens.find((lien) => lien.status === 'active'),
      insurancePolicies: policies,
      ownershipTransfers: transfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      passportTransfers: passportTransfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      chain: verifyPassportChain(passport.id, chainEvents)
    };
  }

  /** Reversal-aware vaccination summary (mirrors the health grading logic). */
  private summarizeVaccinations(
    animal: Animal,
    records: AnimalHealthRecord[]
  ): VaccinationSummary {
    const reversedIds = new Set(
      records.filter((record) => record.reversalOfId).map((record) => record.reversalOfId)
    );
    const effective = records.filter(
      (record) => !record.reversalOfId && !reversedIds.has(record.id)
    );
    const schedule = VACCINATION_SCHEDULES[animal.species] ?? [];
    const vaccinations = effective.filter((record) => record.recordType === 'vaccination');
    const vaccinatedProducts = new Set(vaccinations.map((record) => record.product.toLowerCase()));
    const completedVaccinations = schedule.filter((entry) =>
      vaccinatedProducts.has(entry.toLowerCase())
    );
    const treatments = effective.filter((record) => record.recordType === 'treatment');
    const nowIso = new Date().toISOString();
    return {
      requiredVaccinations: schedule,
      completedVaccinations,
      coverage: schedule.length === 0 ? 1 : completedVaccinations.length / schedule.length,
      vaccinationCount: vaccinations.length,
      treatmentCount: treatments.length,
      activeWithdrawal: treatments.some(
        (record) => record.withdrawalUntil !== undefined && record.withdrawalUntil > nowIso
      ),
      lastVaccinationAt: vaccinations
        .map((record) => record.administeredAt)
        .sort()
        .at(-1)
    };
  }

  private async summarizeMovements(movements: AnimalMovement[]): Promise<MovementLegalitySummary> {
    let withPermit = 0;
    let revoked = 0;
    for (const movement of movements) {
      if (!movement.permitId) {
        continue;
      }
      const permit: MovementPermit | undefined = await this.permits
        .findById(movement.permitId)
        .catch(() => undefined);
      if (permit && permit.status !== 'revoked') {
        withPermit += 1;
      } else {
        revoked += 1;
      }
    }
    const open = movements.filter((movement) => !movement.arrivedAt).length;
    return {
      totalMovements: movements.length,
      movementsWithPermit: withPermit,
      openMovements: open,
      revokedPermits: revoked,
      legal: withPermit + revoked === movements.length && revoked === 0
    };
  }

  /** Appends a hash-chained passport event (seq = chain length, prev = head). */
  private async appendEvent(
    passport: LivestockPassport,
    type: PassportEventType,
    actorId: string,
    payload: Record<string, unknown>
  ): Promise<PassportEvent> {
    const seq = await this.passportEvents.countByPassport(passport.id);
    const trail = seq > 0 ? await this.passportEvents.listByPassport(passport.id) : [];
    const prevEventHash = seq > 0 ? trail[trail.length - 1].eventHash : GENESIS_PREV_HASH;
    const unsigned = {
      passportId: passport.id,
      seq,
      type,
      actorId,
      payload,
      prevEventHash
    };
    const event: PassportEvent = {
      id: newId('lspe'),
      ...unsigned,
      eventHash: computePassportEventHash(passportHashPayloadOf(unsigned)),
      createdAt: new Date().toISOString()
    };
    return this.passportEvents.append(event);
  }
}
