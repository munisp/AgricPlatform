import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Animal,
  AnimalGrade,
  AnimalHealthRecord,
  AnimalMovement,
  DiseaseFlag,
  DiseaseFlagStatus,
  DiseaseMapEntry,
  HealthRecordType,
  LivestockRecall,
  LivestockSpecies,
  MovementPermit,
  MovementPurpose,
  MovementTransportMode,
  PermitSubject,
  PermitVerification,
  RecallAnimal,
  RecallScope,
  User,
  UserRole
} from '@agric-platform/shared';
import {
  NIGERIAN_STATE_CODES,
  VACCINATION_SCHEDULES
} from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { assertSelfOrAdmin } from '../../common/auth/ownership.js';
import { resolveVetSigningSecret } from '../../config/livestock-health.config.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  ANIMAL_REPOSITORY,
  DISEASE_FLAG_REPOSITORY,
  HEALTH_RECORD_REPOSITORY,
  LOT_REPOSITORY,
  MOVEMENT_PERMIT_REPOSITORY,
  MOVEMENT_REPOSITORY,
  RECALL_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  AnimalRepository,
  LotRepository
} from '../../database/repositories/livestock.repository.js';
import type {
  DiseaseFlagRepository,
  HealthRecordRepository,
  MovementPermitRepository,
  MovementRepository,
  RecallRepository
} from '../../database/repositories/livestock-health.repository.js';
import { GovernmentDiseaseNotificationAdapter } from './disease-notification.adapter.js';
import type { DiseaseNotificationResult } from './disease-notification.adapter.js';
import {
  signHealthRecord,
  verifyHealthRecordSignature
} from './health-signing.js';

export interface RecordHealthInput {
  animalId: string;
  recordType: HealthRecordType;
  product: string;
  batchNumber: string;
  dose: string;
  administeredAt: string;
  withdrawalUntil?: string;
  notes?: string;
}

export interface StartMovementInput {
  animalId?: string;
  lotId?: string;
  fromState: string;
  fromLga?: string;
  toState: string;
  toLga?: string;
  departedAt?: string;
  transportMode: MovementTransportMode;
  purpose: MovementPurpose;
  permitId?: string;
}

export interface IssuePermitInput {
  animalIds?: string[];
  lotIds?: string[];
  fromState: string;
  toState: string;
  validFrom: string;
  validUntil: string;
}

export interface PermitVerificationResult {
  permit: MovementPermit;
  subjects: PermitSubject[];
  verification: PermitVerification;
}

export interface InitiateRecallInput {
  animalId?: string;
  lotId?: string;
  ownerUserId?: string;
  state?: string;
  fromDate?: string;
  toDate?: string;
  batchNumber?: string;
  reason: string;
}

export interface RecallWithAnimals {
  recall: LivestockRecall;
  animals: RecallAnimal[];
}

export interface ReportDiseaseFlagInput {
  disease: string;
  state: string;
  lga?: string;
  suspectedSpecies?: LivestockSpecies;
}

export interface GradeComponents {
  /** Fraction of the species vaccination schedule covered (0..1). */
  vaccinationCoverage: number;
  vaccinationPoints: number;
  treatmentPoints: number;
  movementPoints: number;
  agePoints: number;
  movementCount: number;
  requiredVaccinations: readonly string[];
  completedVaccinations: string[];
}

export interface AnimalGradeResult {
  animalId: string;
  species: LivestockSpecies;
  grade: AnimalGrade;
  score: number;
  components: GradeComponents;
  computedAt: string;
}

const PRIVILEGED_READERS: readonly UserRole[] = ['admin', 'vet', 'regulator'];

function requireActor(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for livestock health records');
  }
  return actor;
}

function hasAnyRole(actor: User, roles: readonly UserRole[]): boolean {
  return roles.some((role) => actor.roles.includes(role));
}

function assertIsoDate(value: string, field: string): void {
  // Date.parse is lenient ('1 June 2025' parses); require an ISO-8601 shape.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`'${field}' must be an ISO-8601 timestamp`);
  }
}

@Injectable()
export class LivestockHealthService {
  private readonly signingSecret: string;

  constructor(
    private readonly audit: AuditService,
    private readonly events: DomainEventsService,
    private readonly diseaseNotifier: GovernmentDiseaseNotificationAdapter,
    @Inject(ANIMAL_REPOSITORY) private readonly animals: AnimalRepository,
    @Inject(LOT_REPOSITORY) private readonly lots: LotRepository,
    @Inject(HEALTH_RECORD_REPOSITORY) private readonly healthRecords: HealthRecordRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
    @Inject(MOVEMENT_PERMIT_REPOSITORY) private readonly permits: MovementPermitRepository,
    @Inject(RECALL_REPOSITORY) private readonly recalls: RecallRepository,
    @Inject(DISEASE_FLAG_REPOSITORY) private readonly diseaseFlags: DiseaseFlagRepository
  ) {
    this.signingSecret = resolveVetSigningSecret();
  }

  // -------------------------------------------------------------------------
  // AuthZ helpers

  /** Vet-only write path (admins may act for programme tooling). */
  private requireVet(actor: User | null): User {
    const caller = requireActor(actor);
    if (!hasAnyRole(caller, ['vet', 'admin'])) {
      throw new ForbiddenException('Only a veterinarian can write animal health records');
    }
    return caller;
  }

  /** Vet/regulator/admin path (permits, outbreak confirmation). */
  private requireVetOrRegulator(actor: User | null): User {
    const caller = requireActor(actor);
    if (!hasAnyRole(caller, ['vet', 'regulator', 'admin'])) {
      throw new ForbiddenException('Only a veterinarian or regulator can perform this action');
    }
    return caller;
  }

  /** Regulator/admin path (recall lifecycle). */
  private requireRegulator(actor: User | null): User {
    const caller = requireActor(actor);
    if (!hasAnyRole(caller, ['regulator', 'admin'])) {
      throw new ForbiddenException('Only a regulator can perform this action');
    }
    return caller;
  }

  /** Read path: the animal's owner, or a privileged reader (admin/vet/regulator). */
  private assertReader(actor: User | null, ownerUserId: string): User {
    const caller = requireActor(actor);
    if (caller.id === ownerUserId || hasAnyRole(caller, PRIVILEGED_READERS)) {
      return caller;
    }
    throw new ForbiddenException('You may only access your own animals\u2019 health data');
  }

  private assertValidState(state: string): void {
    if (!NIGERIAN_STATE_CODES[state]) {
      throw new BadRequestException(`Unknown Nigerian state '${state}'`);
    }
  }

  // -------------------------------------------------------------------------
  // Vet-signed health ledger (blueprint F2/F3.4). Append-only: corrections
  // are reversing entries, never updates or deletes.

  /**
   * Records a vaccination/treatment and signs it with the vet's identity.
   * The HMAC signature covers the canonical payload (vet + signing timestamp
   * + animal + product/batch/dose) so any later tamper is detectable.
   */
  async recordHealth(actor: User | null, input: RecordHealthInput): Promise<AnimalHealthRecord> {
    const vet = this.requireVet(actor);
    const animal = await this.animals.getById(input.animalId); // 404 unknown animal
    assertIsoDate(input.administeredAt, 'administeredAt');
    if (input.withdrawalUntil !== undefined) {
      assertIsoDate(input.withdrawalUntil, 'withdrawalUntil');
      if (input.withdrawalUntil < input.administeredAt) {
        throw new BadRequestException('withdrawalUntil cannot precede administeredAt');
      }
    }
    if (!input.product.trim() || !input.batchNumber.trim() || !input.dose.trim()) {
      throw new BadRequestException('product, batchNumber and dose are required');
    }
    const now = new Date().toISOString();
    const signedAt = now;
    const signature = signHealthRecord(
      {
        animalId: animal.id,
        recordType: input.recordType,
        product: input.product,
        batchNumber: input.batchNumber,
        dose: input.dose,
        administeredAt: input.administeredAt,
        vetUserId: vet.id,
        signedAt
      },
      this.signingSecret
    );
    const record: AnimalHealthRecord = {
      id: newId('health'),
      animalId: animal.id,
      recordType: input.recordType,
      product: input.product,
      batchNumber: input.batchNumber,
      dose: input.dose,
      administeredAt: input.administeredAt,
      withdrawalUntil: input.withdrawalUntil,
      vetUserId: vet.id,
      notes: input.notes,
      signature,
      signedAt,
      createdAt: now
    };
    const created = await this.healthRecords.create(record);
    await this.audit.record({
      actorId: vet.id,
      action: 'livestock_health.record_created',
      entityType: 'health_record',
      entityId: created.id,
      metadata: { animalId: animal.id, recordType: created.recordType, product: created.product }
    });
    await this.events.publish(
      'livestock.health.recorded',
      {
        recordId: created.id,
        animalId: animal.id,
        recordType: created.recordType,
        product: created.product,
        batchNumber: created.batchNumber
      },
      vet.id
    );
    return created;
  }

  /**
   * Append-only correction: appends a reversing entry that annuls the
   * original record. A record can be reversed once, and a reversing entry
   * cannot itself be reversed.
   */
  async reverseHealthRecord(
    actor: User | null,
    recordId: string,
    notes?: string
  ): Promise<AnimalHealthRecord> {
    const vet = this.requireVet(actor);
    const original = await this.healthRecords.getById(recordId);
    if (original.reversalOfId) {
      throw new BadRequestException(`Record '${recordId}' is itself a reversing entry`);
    }
    const siblings = await this.healthRecords.find({ animalId: original.animalId });
    if (siblings.some((sibling) => sibling.reversalOfId === original.id)) {
      throw new ConflictException(`Record '${recordId}' has already been reversed`);
    }
    const now = new Date().toISOString();
    const signedAt = now;
    const signature = signHealthRecord(
      {
        animalId: original.animalId,
        recordType: original.recordType,
        product: original.product,
        batchNumber: original.batchNumber,
        dose: original.dose,
        administeredAt: original.administeredAt,
        vetUserId: vet.id,
        signedAt
      },
      this.signingSecret
    );
    const reversal: AnimalHealthRecord = {
      id: newId('health'),
      animalId: original.animalId,
      recordType: original.recordType,
      product: original.product,
      batchNumber: original.batchNumber,
      dose: original.dose,
      administeredAt: original.administeredAt,
      withdrawalUntil: original.withdrawalUntil,
      vetUserId: vet.id,
      notes: notes ?? `Reversal of health record '${original.id}'`,
      signature,
      signedAt,
      reversalOfId: original.id,
      createdAt: now
    };
    const created = await this.healthRecords.create(reversal);
    await this.audit.record({
      actorId: vet.id,
      action: 'livestock_health.record_reversed',
      entityType: 'health_record',
      entityId: original.id,
      metadata: { reversalId: created.id }
    });
    await this.events.publish(
      'livestock.health.reversed',
      { recordId: original.id, reversalId: created.id, animalId: original.animalId },
      vet.id
    );
    return created;
  }

  /** Recomputes the HMAC signature over the stored record (tamper check). */
  async verifyHealthRecord(
    actor: User | null,
    recordId: string
  ): Promise<{
    recordId: string;
    ok: boolean;
    reason?: 'signature';
    reversed: boolean;
    reversalOfId?: string;
  }> {
    requireActor(actor);
    const record = await this.healthRecords.getById(recordId);
    const result = verifyHealthRecordSignature(record, this.signingSecret);
    const siblings = await this.healthRecords.find({ animalId: record.animalId });
    const reversed = siblings.some((sibling) => sibling.reversalOfId === record.id);
    return {
      recordId: record.id,
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
      reversed,
      reversalOfId: record.reversalOfId
    };
  }

  /** Full ledger for an animal (owner/admin/vet/regulator), chronological. */
  async listHealthRecords(actor: User | null, animalId: string): Promise<AnimalHealthRecord[]> {
    const animal = await this.animals.getById(animalId);
    this.assertReader(actor, animal.ownerUserId);
    const records = await this.healthRecords.find({ animalId });
    return records.sort(
      (a, b) =>
        a.administeredAt.localeCompare(b.administeredAt) || a.createdAt.localeCompare(b.createdAt)
    );
  }

  // -------------------------------------------------------------------------
  // Movement log — chain of custody (blueprint F4.1). A movement is open
  // until arrival; an animal/lot with an open movement cannot start another.

  async startMovement(actor: User | null, input: StartMovementInput): Promise<AnimalMovement> {
    const caller = requireActor(actor);
    if ((input.animalId ? 1 : 0) + (input.lotId ? 1 : 0) !== 1) {
      throw new BadRequestException('A movement needs exactly one of animalId or lotId');
    }
    this.assertValidState(input.fromState);
    this.assertValidState(input.toState);
    if (input.departedAt !== undefined) {
      assertIsoDate(input.departedAt, 'departedAt');
    }
    let ownerUserId: string;
    let openCriteria: { animalId?: string; lotId?: string };
    if (input.animalId) {
      const animal = await this.animals.getById(input.animalId);
      if (caller.id !== animal.ownerUserId && !caller.roles.includes('admin')) {
        throw new ForbiddenException('Only the owner can move this animal');
      }
      if (animal.status === 'dead') {
        throw new BadRequestException(`Animal '${input.animalId}' is dead and cannot be moved`);
      }
      ownerUserId = animal.ownerUserId;
      openCriteria = { animalId: input.animalId };
    } else {
      const lot = await this.lots.getById(input.lotId!);
      if (caller.id !== lot.ownerUserId && !caller.roles.includes('admin')) {
        throw new ForbiddenException('Only the owner can move this lot');
      }
      ownerUserId = lot.ownerUserId;
      openCriteria = { lotId: input.lotId };
    }
    const open = await this.movements.findOne({ ...openCriteria, open: true });
    if (open) {
      throw new ConflictException(
        `Open movement '${open.id}' exists; record its arrival before starting another`
      );
    }
    if (input.permitId) {
      await this.assertPermitUsable(input, openCriteria);
    }
    const now = new Date().toISOString();
    const movement: AnimalMovement = {
      id: newId('movement'),
      animalId: input.animalId,
      lotId: input.lotId,
      fromState: input.fromState,
      fromLga: input.fromLga,
      toState: input.toState,
      toLga: input.toLga,
      departedAt: input.departedAt ?? now,
      transportMode: input.transportMode,
      purpose: input.purpose,
      permitId: input.permitId,
      recordedBy: caller.id,
      createdAt: now
    };
    const created = await this.movements.create(movement);
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_health.movement_started',
      entityType: 'movement',
      entityId: created.id,
      metadata: { ...openCriteria, toState: created.toState, ownerUserId }
    });
    await this.events.publish(
      'livestock.movement.started',
      { movementId: created.id, ...openCriteria, fromState: created.fromState, toState: created.toState },
      caller.id
    );
    return created;
  }

  /** Verifies a permit exists, is issued, is inside its validity window, and covers this subject. */
  private async assertPermitUsable(
    input: StartMovementInput,
    subject: { animalId?: string; lotId?: string }
  ): Promise<void> {
    const permit = await this.permits.getById(input.permitId!);
    if (permit.status !== 'issued') {
      throw new BadRequestException(`Permit '${permit.id}' is ${permit.status}`);
    }
    const now = new Date().toISOString();
    if (now < permit.validFrom || now > permit.validUntil) {
      throw new BadRequestException(`Permit '${permit.id}' is outside its validity window`);
    }
    if (permit.fromState !== input.fromState || permit.toState !== input.toState) {
      throw new BadRequestException(
        `Permit '${permit.id}' covers ${permit.fromState}→${permit.toState}, not ${input.fromState}→${input.toState}`
      );
    }
    const subjects = await this.permits.listSubjects(permit.id);
    const covered = subjects.some((entry) =>
      subject.animalId
        ? entry.subjectType === 'animal' && entry.subjectId === subject.animalId
        : entry.subjectType === 'lot' && entry.subjectId === subject.lotId
    );
    if (!covered) {
      throw new ForbiddenException(`Permit '${permit.id}' does not cover this animal/lot`);
    }
  }

  /** Closes an open movement by recording its arrival (owner or admin). */
  async recordArrival(
    actor: User | null,
    movementId: string,
    arrivedAt?: string
  ): Promise<AnimalMovement> {
    const caller = requireActor(actor);
    const movement = await this.movements.getById(movementId);
    const ownerUserId = movement.animalId
      ? (await this.animals.getById(movement.animalId)).ownerUserId
      : (await this.lots.getById(movement.lotId!)).ownerUserId;
    assertSelfOrAdmin(caller, ownerUserId);
    if (movement.arrivedAt) {
      throw new BadRequestException(`Movement '${movementId}' is already closed`);
    }
    if (arrivedAt !== undefined) {
      assertIsoDate(arrivedAt, 'arrivedAt');
    }
    const closedAt = arrivedAt ?? new Date().toISOString();
    if (closedAt < movement.departedAt) {
      throw new BadRequestException('arrivedAt cannot precede departedAt');
    }
    const updated = await this.movements.update(movementId, { arrivedAt: closedAt });
    await this.events.publish(
      'livestock.movement.arrived',
      { movementId, animalId: movement.animalId, lotId: movement.lotId, arrivedAt: closedAt },
      caller.id
    );
    return updated;
  }

  async listAnimalMovements(actor: User | null, animalId: string): Promise<AnimalMovement[]> {
    const animal = await this.animals.getById(animalId);
    this.assertReader(actor, animal.ownerUserId);
    const movements = await this.movements.find({ animalId });
    return movements.sort((a, b) => a.departedAt.localeCompare(b.departedAt));
  }

  async listLotMovements(actor: User | null, lotId: string): Promise<AnimalMovement[]> {
    const lot = await this.lots.getById(lotId);
    this.assertReader(actor, lot.ownerUserId);
    const movements = await this.movements.find({ lotId });
    return movements.sort((a, b) => a.departedAt.localeCompare(b.departedAt));
  }

  // -------------------------------------------------------------------------
  // Movement permits (blueprint F4.3): issue / verify / revoke.

  async issuePermit(actor: User | null, input: IssuePermitInput): Promise<MovementPermit> {
    const issuer = this.requireVetOrRegulator(actor);
    this.assertValidState(input.fromState);
    this.assertValidState(input.toState);
    assertIsoDate(input.validFrom, 'validFrom');
    assertIsoDate(input.validUntil, 'validUntil');
    if (input.validUntil <= input.validFrom) {
      throw new BadRequestException('validUntil must be after validFrom');
    }
    const animalIds = input.animalIds ?? [];
    const lotIds = input.lotIds ?? [];
    if (animalIds.length + lotIds.length === 0) {
      throw new BadRequestException('A permit must reference at least one animal or lot');
    }
    for (const animalId of animalIds) {
      await this.animals.getById(animalId); // 404 unknown animal
    }
    for (const lotId of lotIds) {
      await this.lots.getById(lotId); // 404 unknown lot
    }
    const now = new Date().toISOString();
    const permitNumber = `PMT-${NIGERIAN_STATE_CODES[input.fromState]}-${
      NIGERIAN_STATE_CODES[input.toState]
    }-${randomUUID().slice(0, 8).toUpperCase()}`;
    const permit: MovementPermit = {
      id: newId('permit'),
      permitNumber,
      fromState: input.fromState,
      toState: input.toState,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      status: 'issued',
      issuedBy: issuer.id,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.permits.create(permit);
    for (const animalId of animalIds) {
      await this.permits.addSubject({ permitId: created.id, subjectType: 'animal', subjectId: animalId });
    }
    for (const lotId of lotIds) {
      await this.permits.addSubject({ permitId: created.id, subjectType: 'lot', subjectId: lotId });
    }
    await this.audit.record({
      actorId: issuer.id,
      action: 'livestock_health.permit_issued',
      entityType: 'movement_permit',
      entityId: created.id,
      metadata: { permitNumber, animalIds, lotIds }
    });
    await this.events.publish(
      'livestock.permit.issued',
      { permitId: created.id, permitNumber, fromState: created.fromState, toState: created.toState },
      issuer.id
    );
    return created;
  }

  /**
   * Permit verification (any authenticated caller — market/checkpoint
   * lookups). Accepts the permit id or its human-facing permit number.
   */
  async verifyPermit(actor: User | null, idOrNumber: string): Promise<PermitVerificationResult> {
    requireActor(actor);
    const permit =
      (await this.permits.findById(idOrNumber)) ??
      (await this.permits.findByPermitNumber(idOrNumber));
    if (!permit) {
      throw new BadRequestException(`No movement permit matches '${idOrNumber}'`);
    }
    const now = new Date().toISOString();
    const verification: PermitVerification =
      permit.status === 'revoked'
        ? 'revoked'
        : now < permit.validFrom || now > permit.validUntil
          ? 'expired'
          : 'valid';
    return { permit, subjects: await this.permits.listSubjects(permit.id), verification };
  }

  async revokePermit(actor: User | null, permitId: string, reason: string): Promise<MovementPermit> {
    const caller = this.requireVetOrRegulator(actor);
    const permit = await this.permits.getById(permitId);
    if (permit.status === 'revoked') {
      throw new BadRequestException(`Permit '${permitId}' is already revoked`);
    }
    if (!reason?.trim()) {
      throw new BadRequestException('A revocation reason is required');
    }
    const updated = await this.permits.update(permitId, {
      status: 'revoked',
      revokedReason: reason,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: caller.id,
      action: 'livestock_health.permit_revoked',
      entityType: 'movement_permit',
      entityId: permitId,
      metadata: { reason }
    });
    await this.events.publish(
      'livestock.permit.revoked',
      { permitId, permitNumber: permit.permitNumber, reason },
      caller.id
    );
    return updated;
  }

  // -------------------------------------------------------------------------
  // Recall (blueprint F4.2 — 24-hour traceback). Affected animals are
  // computed from health records (batch match), movements and lot
  // membership, then materialised into livestock.recall_animals.

  async initiateRecall(actor: User | null, input: InitiateRecallInput): Promise<RecallWithAnimals> {
    const initiator = this.requireRegulator(actor);
    if (!input.reason?.trim()) {
      throw new BadRequestException('A recall reason is required');
    }
    const scopeFields = [input.animalId, input.lotId, input.ownerUserId, input.state].filter(
      (value) => value !== undefined
    );
    if (scopeFields.length !== 1) {
      throw new BadRequestException(
        'Recall scope needs exactly one of animalId, lotId, ownerUserId or state'
      );
    }
    const scope: RecallScope = input.animalId
      ? 'animal'
      : input.lotId
        ? 'lot'
        : input.ownerUserId
          ? 'owner'
          : 'region';
    if (input.state) {
      this.assertValidState(input.state);
    }
    if (input.fromDate !== undefined) {
      assertIsoDate(input.fromDate, 'fromDate');
    }
    if (input.toDate !== undefined) {
      assertIsoDate(input.toDate, 'toDate');
    }
    if (input.fromDate && input.toDate && input.toDate < input.fromDate) {
      throw new BadRequestException('toDate cannot precede fromDate');
    }
    const affected = await this.computeRecallAnimals(scope, input);
    if (affected.length === 0) {
      throw new BadRequestException('Recall scope matches no registered animals');
    }
    const now = new Date().toISOString();
    const recall: LivestockRecall = {
      id: newId('recall'),
      scope,
      animalId: input.animalId,
      lotId: input.lotId,
      ownerUserId: input.ownerUserId,
      state: input.state,
      fromDate: input.fromDate,
      toDate: input.toDate,
      batchNumber: input.batchNumber,
      reason: input.reason,
      status: 'initiated',
      initiatedBy: initiator.id,
      createdAt: now
    };
    const created = await this.recalls.create(recall);
    const entries: RecallAnimal[] = affected.map((animal) => ({
      recallId: created.id,
      animalId: animal.id,
      ownerUserId: animal.ownerUserId
    }));
    for (const entry of entries) {
      await this.recalls.addAnimal(entry);
    }
    await this.audit.record({
      actorId: initiator.id,
      action: 'livestock_health.recall_initiated',
      entityType: 'recall',
      entityId: created.id,
      metadata: { scope, affectedAnimals: entries.length, batchNumber: input.batchNumber }
    });
    const ownerUserIds = [...new Set(entries.map((entry) => entry.ownerUserId))].sort();
    await this.events.publish(
      'livestock.recall.initiated',
      {
        recallId: created.id,
        scope,
        reason: created.reason,
        animalIds: entries.map((entry) => entry.animalId),
        ownerUserIds
      },
      initiator.id
    );
    return { recall: created, animals: entries };
  }

  /**
   * Recall scope resolution:
   *  - animal scope: the animal itself;
   *  - lot scope: current lot members;
   *  - owner scope: every animal the owner holds;
   *  - region scope: animals located in the state with a health record
   *    administered inside the date range (optionally batch-filtered) or a
   *    movement departing inside the range; with no range/batch, all animals
   *    in the state.
   * A batchNumber filter intersects the base set with animals carrying a
   * matching health record. Finally, lot membership expansion adds every
   * lot-mate of an affected animal (shared pens spread contamination).
   */
  private async computeRecallAnimals(scope: RecallScope, input: InitiateRecallInput): Promise<Animal[]> {
    let base: Animal[];
    if (scope === 'animal') {
      base = [await this.animals.getById(input.animalId!)];
    } else if (scope === 'lot') {
      await this.lots.getById(input.lotId!); // 404 unknown lot
      const memberIds = await this.lots.listAnimalIds(input.lotId!);
      base = [];
      for (const memberId of memberIds) {
        const animal = await this.animals.findById(memberId);
        if (animal) {
          base.push(animal);
        }
      }
    } else if (scope === 'owner') {
      base = await this.animals.find({ ownerUserId: input.ownerUserId });
    } else {
      const candidates = await this.animals.find({ state: input.state });
      const inRange = (timestamp: string): boolean =>
        (!input.fromDate || timestamp >= input.fromDate) &&
        (!input.toDate || timestamp <= input.toDate);
      const hasWindow = Boolean(input.fromDate || input.toDate || input.batchNumber);
      base = [];
      for (const animal of candidates) {
        if (!hasWindow) {
          base.push(animal);
          continue;
        }
        const records = await this.healthRecords.find({ animalId: animal.id });
        const recordHit = records.some(
          (record) =>
            (!input.batchNumber || record.batchNumber === input.batchNumber) &&
            inRange(record.administeredAt)
        );
        const movements = await this.movements.find({ animalId: animal.id });
        const movementHit =
          !input.batchNumber && movements.some((movement) => inRange(movement.departedAt));
        if (recordHit || movementHit) {
          base.push(animal);
        }
      }
    }
    if (input.batchNumber && scope !== 'region') {
      const filtered: Animal[] = [];
      for (const animal of base) {
        const records = await this.healthRecords.find({
          animalId: animal.id,
          batchNumber: input.batchNumber
        });
        if (records.length > 0) {
          filtered.push(animal);
        }
      }
      base = filtered;
    }
    // Lot-membership expansion: add every lot-mate of an affected animal.
    const affected = new Map<string, Animal>(base.map((animal) => [animal.id, animal]));
    const allLots = await this.lots.all();
    for (const lot of allLots) {
      const memberIds = await this.lots.listAnimalIds(lot.id);
      if (memberIds.some((memberId) => affected.has(memberId))) {
        for (const memberId of memberIds) {
          if (!affected.has(memberId)) {
            const animal = await this.animals.findById(memberId);
            if (animal) {
              affected.set(animal.id, animal);
            }
          }
        }
      }
    }
    return [...affected.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Recall detail. Readable by regulators/admins and by owners whose animals
   * are materialised in the case.
   */
  async getRecall(actor: User | null, recallId: string): Promise<RecallWithAnimals> {
    const caller = requireActor(actor);
    const recall = await this.recalls.getById(recallId);
    const animals = await this.recalls.listAnimals(recallId);
    if (
      !hasAnyRole(caller, ['regulator', 'admin']) &&
      !animals.some((entry) => entry.ownerUserId === caller.id)
    ) {
      throw new ForbiddenException('You may only view recalls affecting your own animals');
    }
    return { recall, animals };
  }

  async listRecalls(actor: User | null, filter: { status?: LivestockRecall['status'] }): Promise<LivestockRecall[]> {
    this.requireRegulator(actor);
    return this.recalls.find({ status: filter.status });
  }

  /**
   * Internal lifecycle hook: flips initiated → notified after the recall
   * listener has delivered owner notifications. Not an endpoint.
   */
  async markRecallNotified(recallId: string): Promise<LivestockRecall> {
    const recall = await this.recalls.getById(recallId);
    if (recall.status !== 'initiated') {
      throw new BadRequestException(`Recall '${recallId}' is ${recall.status}, expected initiated`);
    }
    return this.recalls.update(recallId, {
      status: 'notified',
      notifiedAt: new Date().toISOString()
    });
  }

  async resolveRecall(actor: User | null, recallId: string): Promise<LivestockRecall> {
    const resolver = this.requireRegulator(actor);
    const recall = await this.recalls.getById(recallId);
    if (recall.status !== 'notified') {
      throw new BadRequestException(
        `Recall '${recallId}' is ${recall.status}; owners must be notified before resolution`
      );
    }
    const updated = await this.recalls.update(recallId, {
      status: 'resolved',
      resolvedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: resolver.id,
      action: 'livestock_health.recall_resolved',
      entityType: 'recall',
      entityId: recallId,
      metadata: {}
    });
    await this.events.publish('livestock.recall.resolved', { recallId }, resolver.id);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Disease surveillance (blueprint F5.1/F5.4).

  async reportDiseaseFlag(actor: User | null, input: ReportDiseaseFlagInput): Promise<DiseaseFlag> {
    const reporter = requireActor(actor);
    if (!input.disease.trim()) {
      throw new BadRequestException('disease is required');
    }
    this.assertValidState(input.state);
    const now = new Date().toISOString();
    const flag: DiseaseFlag = {
      id: newId('dflag'),
      disease: input.disease,
      state: input.state,
      lga: input.lga,
      suspectedSpecies: input.suspectedSpecies,
      reporterUserId: reporter.id,
      status: 'reported',
      createdAt: now,
      updatedAt: now
    };
    const created = await this.diseaseFlags.create(flag);
    await this.events.publish(
      'livestock.disease_flag.reported',
      { flagId: created.id, disease: created.disease, state: created.state },
      reporter.id
    );
    return created;
  }

  /**
   * Confirms a reported flag (vet/regulator/admin). Confirmed flags feed the
   * state disease map and are pushed to the government notification adapter
   * (which fails closed when unconfigured — the confirm itself stands).
   */
  async confirmDiseaseFlag(
    actor: User | null,
    flagId: string
  ): Promise<{ flag: DiseaseFlag; notification: DiseaseNotificationResult }> {
    const confirmer = this.requireVetOrRegulator(actor);
    const flag = await this.diseaseFlags.getById(flagId);
    if (flag.status !== 'reported') {
      throw new BadRequestException(`Disease flag '${flagId}' is ${flag.status}, expected reported`);
    }
    const updated = await this.diseaseFlags.update(flagId, {
      status: 'confirmed',
      confirmedBy: confirmer.id,
      updatedAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId: confirmer.id,
      action: 'livestock_health.disease_flag_confirmed',
      entityType: 'disease_flag',
      entityId: flagId,
      metadata: { disease: flag.disease, state: flag.state }
    });
    await this.events.publish(
      'livestock.disease_flag.confirmed',
      { flagId, disease: flag.disease, state: flag.state, confirmedBy: confirmer.id },
      confirmer.id
    );
    const notification = await this.diseaseNotifier.notifyConfirmed(updated);
    return { flag: updated, notification };
  }

  /**
   * False-positive handling: retracts a flag with a mandatory reason. The
   * reporter may retract their own flag; regulators/admins may retract any.
   */
  async retractDiseaseFlag(actor: User | null, flagId: string, reason: string): Promise<DiseaseFlag> {
    const caller = requireActor(actor);
    const flag = await this.diseaseFlags.getById(flagId);
    if (caller.id !== flag.reporterUserId && !hasAnyRole(caller, ['regulator', 'admin'])) {
      throw new ForbiddenException('Only the reporter or a regulator can retract this flag');
    }
    if (flag.status === 'retracted') {
      throw new BadRequestException(`Disease flag '${flagId}' is already retracted`);
    }
    if (!reason?.trim()) {
      throw new BadRequestException('A retraction reason is required (false-positive audit trail)');
    }
    const updated = await this.diseaseFlags.update(flagId, {
      status: 'retracted',
      retractedReason: reason,
      updatedAt: new Date().toISOString()
    });
    await this.events.publish(
      'livestock.disease_flag.retracted',
      { flagId, reason },
      caller.id
    );
    return updated;
  }

  async listDiseaseFlags(
    actor: User | null,
    filter: { status?: DiseaseFlagStatus; state?: string }
  ): Promise<DiseaseFlag[]> {
    requireActor(actor);
    return this.diseaseFlags.find({ status: filter.status, state: filter.state });
  }

  /** State-level disease map feed: confirmed flags grouped by state+disease. */
  async diseaseMap(actor: User | null, state?: string): Promise<DiseaseMapEntry[]> {
    requireActor(actor);
    if (state !== undefined) {
      this.assertValidState(state);
    }
    const confirmed = await this.diseaseFlags.find({ status: 'confirmed', state });
    const grouped = new Map<string, DiseaseMapEntry>();
    for (const flag of confirmed) {
      const key = `${flag.state}|${flag.disease}`;
      const entry = grouped.get(key) ?? {
        state: flag.state,
        disease: flag.disease,
        confirmedFlags: 0,
        latestReportedAt: flag.createdAt
      };
      entry.confirmedFlags += 1;
      if (flag.createdAt > entry.latestReportedAt) {
        entry.latestReportedAt = flag.createdAt;
      }
      grouped.set(key, entry);
    }
    return [...grouped.values()].sort(
      (a, b) => a.state.localeCompare(b.state) || a.disease.localeCompare(b.disease)
    );
  }

  // -------------------------------------------------------------------------
  // Trust grade (blueprint F5.2). Deterministic rubric over 100 points:
  //
  //  - Vaccination coverage (50 pts): share of the species schedule
  //    (VACCINATION_SCHEDULES) with an effective (non-reversed) vaccination
  //    record, scaled linearly.
  //  - Treatment recency (20 pts): 20 when no effective treatment in the
  //    last 90 days; 10 when a recent treatment exists but every withdrawal
  //    window has passed; 0 while any withdrawal window is still active
  //    (food-safety hold).
  //  - Movement discipline (15 pts): <= 3 logged movements → 15, <= 10 → 10,
  //    more → 5 (frequent movement raises exposure risk).
  //  - Age (15 pts): known birthDate in the prime production window
  //    (6 months – 8 years) → 15; known but outside → 8; unknown → 5.
  //
  //  Grade bands: A >= 85, B >= 70, C >= 50, D < 50.

  async gradeAnimal(actor: User | null, animalId: string): Promise<AnimalGradeResult> {
    const animal = await this.animals.getById(animalId);
    this.assertReader(actor, animal.ownerUserId);
    const now = new Date();
    const nowIso = now.toISOString();

    const records = await this.healthRecords.find({ animalId });
    const reversedIds = new Set(
      records.filter((record) => record.reversalOfId).map((record) => record.reversalOfId)
    );
    const effective = records.filter(
      (record) => !record.reversalOfId && !reversedIds.has(record.id)
    );

    const schedule = VACCINATION_SCHEDULES[animal.species];
    const vaccinatedProducts = new Set(
      effective
        .filter((record) => record.recordType === 'vaccination')
        .map((record) => record.product.toLowerCase())
    );
    const completedVaccinations = schedule.filter((entry) =>
      vaccinatedProducts.has(entry.toLowerCase())
    );
    const coverage = schedule.length === 0 ? 1 : completedVaccinations.length / schedule.length;
    const vaccinationPoints = Math.round(50 * coverage);

    const treatments = effective.filter((record) => record.recordType === 'treatment');
    const activeWithdrawal = treatments.some(
      (record) => record.withdrawalUntil !== undefined && record.withdrawalUntil > nowIso
    );
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const recentTreatment = treatments.some((record) => record.administeredAt >= ninetyDaysAgo);
    const treatmentPoints = activeWithdrawal ? 0 : recentTreatment ? 10 : 20;

    const movementCount = await this.movements.count({ animalId });
    const movementPoints = movementCount <= 3 ? 15 : movementCount <= 10 ? 10 : 5;

    let agePoints: number;
    if (!animal.birthDate || Number.isNaN(Date.parse(animal.birthDate))) {
      agePoints = 5;
    } else {
      const ageDays = (now.getTime() - Date.parse(animal.birthDate)) / (24 * 60 * 60 * 1000);
      agePoints = ageDays >= 183 && ageDays <= 8 * 365 ? 15 : 8;
    }

    const score = vaccinationPoints + treatmentPoints + movementPoints + agePoints;
    const grade: AnimalGrade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
    return {
      animalId,
      species: animal.species,
      grade,
      score,
      components: {
        vaccinationCoverage: coverage,
        vaccinationPoints,
        treatmentPoints,
        movementPoints,
        agePoints,
        movementCount,
        requiredVaccinations: schedule,
        completedVaccinations
      },
      computedAt: nowIso
    };
  }
}
