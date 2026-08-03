import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  AnimalHealthRecord,
  AnimalMovement,
  DiseaseFlag,
  DiseaseFlagStatus,
  HealthRecordType,
  LivestockRecall,
  MovementPermit,
  PermitStatus,
  PermitSubject,
  RecallAnimal,
  RecallScope,
  RecallStatus
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * ALTP livestock health/traceability persistence ports (wave L1b,
 * infra/postgres/013). The in-memory implementations mirror the pg semantics
 * (append-only health ledger, open-movement uniqueness, materialised recall
 * animals) so unit tests keep full fidelity.
 */

// ---------------------------------------------------------------------------
// Vet-signed health ledger (append-only — the port exposes no update/remove).

export interface HealthRecordCriteria {
  animalId?: string;
  recordType?: HealthRecordType;
  batchNumber?: string;
  vetUserId?: string;
}

/**
 * Append-only ledger port. There is deliberately no update/remove: a
 * correction is a new reversing entry (reversalOfId), never a mutation.
 */
export interface HealthRecordRepository {
  all(): Promise<AnimalHealthRecord[]>;
  find(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord[]>;
  findOne(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord | undefined>;
  findById(id: string): Promise<AnimalHealthRecord | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getById(id: string): Promise<AnimalHealthRecord>;
  create(item: AnimalHealthRecord): Promise<AnimalHealthRecord>;
  count(criteria?: HealthRecordCriteria): Promise<number>;
}

export function healthRecordMatcher(
  criteria: HealthRecordCriteria
): (record: AnimalHealthRecord) => boolean {
  return (record) =>
    (!criteria.animalId || record.animalId === criteria.animalId) &&
    (!criteria.recordType || record.recordType === criteria.recordType) &&
    (!criteria.batchNumber || record.batchNumber === criteria.batchNumber) &&
    (!criteria.vetUserId || record.vetUserId === criteria.vetUserId);
}

export class InMemoryHealthRecordRepository implements HealthRecordRepository {
  private readonly items = new Map<string, AnimalHealthRecord>();

  constructor(seed: readonly AnimalHealthRecord[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async all(): Promise<AnimalHealthRecord[]> {
    return [...this.items.values()];
  }

  async find(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord[]> {
    return (await this.all()).filter(healthRecordMatcher(criteria));
  }

  async findOne(criteria: HealthRecordCriteria): Promise<AnimalHealthRecord | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<AnimalHealthRecord | undefined> {
    return this.items.get(id);
  }

  async getById(id: string): Promise<AnimalHealthRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException(`Health record with id '${id}' not found`);
    }
    return record;
  }

  async create(item: AnimalHealthRecord): Promise<AnimalHealthRecord> {
    if (this.items.has(item.id)) {
      throw new ConflictException(`Health record with id '${item.id}' already exists`);
    }
    this.items.set(item.id, item);
    return item;
  }

  async count(criteria?: HealthRecordCriteria): Promise<number> {
    return criteria !== undefined ? (await this.find(criteria)).length : this.items.size;
  }
}

export function createInMemoryHealthRecordRepository(
  seed: readonly AnimalHealthRecord[] = []
): InMemoryHealthRecordRepository {
  return new InMemoryHealthRecordRepository(seed);
}

// ---------------------------------------------------------------------------
// Movement log (chain of custody).

export interface MovementCriteria {
  animalId?: string;
  lotId?: string;
  permitId?: string;
  /** True matches only open movements (arrivedAt not yet recorded). */
  open?: boolean;
}

export interface MovementRepository extends AsyncRepository<AnimalMovement, MovementCriteria> {}

export function movementMatcher(criteria: MovementCriteria): (movement: AnimalMovement) => boolean {
  return (movement) =>
    (!criteria.animalId || movement.animalId === criteria.animalId) &&
    (!criteria.lotId || movement.lotId === criteria.lotId) &&
    (!criteria.permitId || movement.permitId === criteria.permitId) &&
    (criteria.open === undefined || (movement.arrivedAt === undefined) === criteria.open);
}

export class InMemoryMovementRepository
  extends InMemoryRepository<AnimalMovement, MovementCriteria>
  implements MovementRepository
{
  constructor(seed: readonly AnimalMovement[] = []) {
    super(seed, movementMatcher);
  }
}

export function createInMemoryMovementRepository(
  seed: readonly AnimalMovement[] = []
): InMemoryMovementRepository {
  return new InMemoryMovementRepository(seed);
}

// ---------------------------------------------------------------------------
// Movement permits.

export interface MovementPermitCriteria {
  status?: PermitStatus;
  fromState?: string;
  toState?: string;
}

export interface MovementPermitRepository
  extends AsyncRepository<MovementPermit, MovementPermitCriteria> {
  findByPermitNumber(permitNumber: string): Promise<MovementPermit | undefined>;
  /** Registers an animal/lot subject on a permit; duplicates are a 409. */
  addSubject(subject: PermitSubject): Promise<void>;
  listSubjects(permitId: string): Promise<PermitSubject[]>;
}

export function movementPermitMatcher(
  criteria: MovementPermitCriteria
): (permit: MovementPermit) => boolean {
  return (permit) =>
    (!criteria.status || permit.status === criteria.status) &&
    (!criteria.fromState || permit.fromState === criteria.fromState) &&
    (!criteria.toState || permit.toState === criteria.toState);
}

export class InMemoryMovementPermitRepository
  extends InMemoryRepository<MovementPermit, MovementPermitCriteria>
  implements MovementPermitRepository
{
  private readonly subjects = new Map<string, PermitSubject[]>();

  constructor(seed: readonly MovementPermit[] = []) {
    super(seed, movementPermitMatcher);
  }

  async findByPermitNumber(permitNumber: string): Promise<MovementPermit | undefined> {
    return (await this.all()).find((permit) => permit.permitNumber === permitNumber);
  }

  override async create(item: MovementPermit): Promise<MovementPermit> {
    if (await this.findByPermitNumber(item.permitNumber)) {
      throw new ConflictException(`Permit number '${item.permitNumber}' is already issued`);
    }
    return super.create(item);
  }

  async addSubject(subject: PermitSubject): Promise<void> {
    await this.getById(subject.permitId);
    const subjects = this.subjects.get(subject.permitId) ?? [];
    if (
      subjects.some(
        (existing) =>
          existing.subjectType === subject.subjectType && existing.subjectId === subject.subjectId
      )
    ) {
      throw new ConflictException(
        `${subject.subjectType} '${subject.subjectId}' is already on permit '${subject.permitId}'`
      );
    }
    subjects.push({ ...subject });
    this.subjects.set(subject.permitId, subjects);
  }

  async listSubjects(permitId: string): Promise<PermitSubject[]> {
    return (this.subjects.get(permitId) ?? []).map((subject) => ({ ...subject }));
  }
}

export function createInMemoryMovementPermitRepository(
  seed: readonly MovementPermit[] = []
): InMemoryMovementPermitRepository {
  return new InMemoryMovementPermitRepository(seed);
}

// ---------------------------------------------------------------------------
// Recalls (with materialised recall_animals membership, mirroring lot members).

export interface RecallCriteria {
  status?: RecallStatus;
  scope?: RecallScope;
  state?: string;
  initiatedBy?: string;
}

export interface RecallRepository extends AsyncRepository<LivestockRecall, RecallCriteria> {
  /** Materialises an affected animal into the case; duplicates are a 409. */
  addAnimal(entry: RecallAnimal): Promise<void>;
  /** Recall animals in insertion order. */
  listAnimals(recallId: string): Promise<RecallAnimal[]>;
  /**
   * Recalls affecting an owner's animals (recall_animals join). Powers the
   * owner-scoped GET /livestock-health/recalls/mine (G18).
   */
  recallsForOwner(ownerUserId: string): Promise<LivestockRecall[]>;
}

export function recallMatcher(criteria: RecallCriteria): (recall: LivestockRecall) => boolean {
  return (recall) =>
    (!criteria.status || recall.status === criteria.status) &&
    (!criteria.scope || recall.scope === criteria.scope) &&
    (!criteria.state || recall.state === criteria.state) &&
    (!criteria.initiatedBy || recall.initiatedBy === criteria.initiatedBy);
}

export class InMemoryRecallRepository
  extends InMemoryRepository<LivestockRecall, RecallCriteria>
  implements RecallRepository
{
  private readonly members = new Map<string, RecallAnimal[]>();

  constructor(seed: readonly LivestockRecall[] = []) {
    super(seed, recallMatcher);
  }

  async addAnimal(entry: RecallAnimal): Promise<void> {
    await this.getById(entry.recallId);
    const members = this.members.get(entry.recallId) ?? [];
    if (members.some((member) => member.animalId === entry.animalId)) {
      throw new ConflictException(
        `Animal '${entry.animalId}' is already in recall '${entry.recallId}'`
      );
    }
    members.push({ ...entry });
    this.members.set(entry.recallId, members);
  }

  async listAnimals(recallId: string): Promise<RecallAnimal[]> {
    return (this.members.get(recallId) ?? []).map((member) => ({ ...member }));
  }

  async recallsForOwner(ownerUserId: string): Promise<LivestockRecall[]> {
    const affected = (await this.all()).filter((recall) =>
      (this.members.get(recall.id) ?? []).some((entry) => entry.ownerUserId === ownerUserId)
    );
    return affected.map((recall) => ({ ...recall }));
  }
}

export function createInMemoryRecallRepository(
  seed: readonly LivestockRecall[] = []
): InMemoryRecallRepository {
  return new InMemoryRecallRepository(seed);
}

// ---------------------------------------------------------------------------
// Disease surveillance flags.

export interface DiseaseFlagCriteria {
  status?: DiseaseFlagStatus;
  state?: string;
  disease?: string;
  reporterUserId?: string;
}

export interface DiseaseFlagRepository
  extends AsyncRepository<DiseaseFlag, DiseaseFlagCriteria> {}

export function diseaseFlagMatcher(criteria: DiseaseFlagCriteria): (flag: DiseaseFlag) => boolean {
  return (flag) =>
    (!criteria.status || flag.status === criteria.status) &&
    (!criteria.state || flag.state === criteria.state) &&
    (!criteria.disease || flag.disease === criteria.disease) &&
    (!criteria.reporterUserId || flag.reporterUserId === criteria.reporterUserId);
}

export class InMemoryDiseaseFlagRepository
  extends InMemoryRepository<DiseaseFlag, DiseaseFlagCriteria>
  implements DiseaseFlagRepository
{
  constructor(seed: readonly DiseaseFlag[] = []) {
    super(seed, diseaseFlagMatcher);
  }
}

export function createInMemoryDiseaseFlagRepository(
  seed: readonly DiseaseFlag[] = []
): InMemoryDiseaseFlagRepository {
  return new InMemoryDiseaseFlagRepository(seed);
}
