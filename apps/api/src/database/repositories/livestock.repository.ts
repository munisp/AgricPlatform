import { ConflictException } from '@nestjs/common';
import type {
  Animal,
  AnimalStatus,
  LivestockLot,
  LivestockSpecies,
  LotStatus,
  OwnershipTransfer,
  PastoralistProfile
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * ALTP livestock persistence ports (wave L1a, infra/postgres/012). The
 * in-memory implementations mirror the pg semantics (atomic serial issuance,
 * transactional ownership transfer) so unit tests keep full fidelity.
 */

export interface AnimalCriteria {
  ownerUserId?: string;
  species?: LivestockSpecies;
  status?: AnimalStatus;
  state?: string;
  tagId?: string;
}

export interface AnimalRepository extends AsyncRepository<Animal, AnimalCriteria> {
  /**
   * Atomically issues the next serial for (species, state) — pg uses
   * INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING on
   * livestock.animal_serials; the in-memory implementation increments a
   * per-key counter. Serials are 1-based.
   */
  nextSerial(species: LivestockSpecies, state: string): Promise<number>;
  findByTagId(tagId: string): Promise<Animal | undefined>;
  /**
   * Records the ownership transfer ledger row and updates the animal's
   * owner_user_id — a single transaction in pg.
   */
  transferOwnership(transfer: OwnershipTransfer): Promise<void>;
}

export function animalMatcher(criteria: AnimalCriteria): (animal: Animal) => boolean {
  return (animal) =>
    (!criteria.ownerUserId || animal.ownerUserId === criteria.ownerUserId) &&
    (!criteria.species || animal.species === criteria.species) &&
    (!criteria.status || animal.status === criteria.status) &&
    (!criteria.state || animal.state === criteria.state) &&
    (!criteria.tagId || animal.tagId === criteria.tagId);
}

export class InMemoryAnimalRepository
  extends InMemoryRepository<Animal, AnimalCriteria>
  implements AnimalRepository
{
  private readonly serials = new Map<string, number>();

  constructor(
    seed: readonly Animal[] = [],
    private readonly transfers?: InMemoryOwnershipTransferRepository
  ) {
    super(seed, animalMatcher);
  }

  private bumpSerial(key: string): number {
    const serial = (this.serials.get(key) ?? 0) + 1;
    this.serials.set(key, serial);
    return serial;
  }

  async nextSerial(species: LivestockSpecies, state: string): Promise<number> {
    return this.bumpSerial(`${species}:${state}`);
  }

  async findByTagId(tagId: string): Promise<Animal | undefined> {
    return (await this.all()).find((animal) => animal.tagId === tagId);
  }

  async create(item: Animal): Promise<Animal> {
    if (item.tagId && (await this.findByTagId(item.tagId))) {
      throw new ConflictException(`Tag id '${item.tagId}' is already registered`);
    }
    return super.create(item);
  }

  async transferOwnership(transfer: OwnershipTransfer): Promise<void> {
    if (!this.transfers) {
      throw new Error('InMemoryAnimalRepository.transferOwnership requires a transfer repository');
    }
    await this.transfers.create(transfer);
    await this.update(transfer.animalId, {
      ownerUserId: transfer.toUserId,
      updatedAt: new Date().toISOString()
    });
  }
}

export function createInMemoryAnimalRepository(
  transfers?: InMemoryOwnershipTransferRepository,
  seed: readonly Animal[] = []
): InMemoryAnimalRepository {
  return new InMemoryAnimalRepository(seed, transfers);
}

// ---------------------------------------------------------------------------

export interface OwnershipTransferCriteria {
  animalId?: string;
  fromUserId?: string;
  toUserId?: string;
}

export interface OwnershipTransferRepository
  extends AsyncRepository<OwnershipTransfer, OwnershipTransferCriteria> {}

export function ownershipTransferMatcher(
  criteria: OwnershipTransferCriteria
): (transfer: OwnershipTransfer) => boolean {
  return (transfer) =>
    (!criteria.animalId || transfer.animalId === criteria.animalId) &&
    (!criteria.fromUserId || transfer.fromUserId === criteria.fromUserId) &&
    (!criteria.toUserId || transfer.toUserId === criteria.toUserId);
}

export class InMemoryOwnershipTransferRepository
  extends InMemoryRepository<OwnershipTransfer, OwnershipTransferCriteria>
  implements OwnershipTransferRepository
{
  constructor(seed: readonly OwnershipTransfer[] = []) {
    super(seed, ownershipTransferMatcher);
  }
}

export function createInMemoryOwnershipTransferRepository(
  seed: readonly OwnershipTransfer[] = []
): InMemoryOwnershipTransferRepository {
  return new InMemoryOwnershipTransferRepository(seed);
}

// ---------------------------------------------------------------------------

export interface LotCriteria {
  ownerUserId?: string;
  species?: LivestockSpecies;
  status?: LotStatus;
  state?: string;
}

export interface LotRepository extends AsyncRepository<LivestockLot, LotCriteria> {
  /** Atomically issues the next lot serial for (species, state). */
  nextLotSerial(species: LivestockSpecies, state: string): Promise<number>;
  /** Adds an animal to a lot; duplicate membership is a 409. */
  addAnimal(lotId: string, animalId: string): Promise<void>;
  /** Removes an animal from a lot; false when it was not a member. */
  removeAnimal(lotId: string, animalId: string): Promise<boolean>;
  /** Member animal IDs in insertion order. */
  listAnimalIds(lotId: string): Promise<string[]>;
}

export function lotMatcher(criteria: LotCriteria): (lot: LivestockLot) => boolean {
  return (lot) =>
    (!criteria.ownerUserId || lot.ownerUserId === criteria.ownerUserId) &&
    (!criteria.species || lot.species === criteria.species) &&
    (!criteria.status || lot.status === criteria.status) &&
    (!criteria.state || lot.state === criteria.state);
}

export class InMemoryLotRepository
  extends InMemoryRepository<LivestockLot, LotCriteria>
  implements LotRepository
{
  private readonly serials = new Map<string, number>();
  private readonly members = new Map<string, string[]>();

  constructor(seed: readonly LivestockLot[] = []) {
    super(seed, lotMatcher);
  }

  async nextLotSerial(species: LivestockSpecies, state: string): Promise<number> {
    const key = `${species}:${state}`;
    const serial = (this.serials.get(key) ?? 0) + 1;
    this.serials.set(key, serial);
    return serial;
  }

  async addAnimal(lotId: string, animalId: string): Promise<void> {
    await this.getById(lotId);
    const members = this.members.get(lotId) ?? [];
    if (members.includes(animalId)) {
      throw new ConflictException(`Animal '${animalId}' is already in lot '${lotId}'`);
    }
    members.push(animalId);
    this.members.set(lotId, members);
  }

  async removeAnimal(lotId: string, animalId: string): Promise<boolean> {
    await this.getById(lotId);
    const members = this.members.get(lotId) ?? [];
    const index = members.indexOf(animalId);
    if (index === -1) {
      return false;
    }
    members.splice(index, 1);
    return true;
  }

  async listAnimalIds(lotId: string): Promise<string[]> {
    return [...(this.members.get(lotId) ?? [])];
  }
}

export function createInMemoryLotRepository(
  seed: readonly LivestockLot[] = []
): InMemoryLotRepository {
  return new InMemoryLotRepository(seed);
}

// ---------------------------------------------------------------------------

/** Pastoralist profile port (keyed by user_id, mirrors the profile module). */
export interface PastoralistProfileRepository {
  findByUserId(userId: string): Promise<PastoralistProfile | undefined>;
  upsert(profile: PastoralistProfile): Promise<PastoralistProfile>;
}

export class InMemoryPastoralistProfileRepository implements PastoralistProfileRepository {
  private readonly profiles = new Map<string, PastoralistProfile>();

  constructor(seed: readonly PastoralistProfile[] = []) {
    for (const profile of seed) {
      this.profiles.set(profile.userId, structuredClone(profile));
    }
  }

  async findByUserId(userId: string): Promise<PastoralistProfile | undefined> {
    return this.profiles.get(userId);
  }

  async upsert(profile: PastoralistProfile): Promise<PastoralistProfile> {
    this.profiles.set(profile.userId, profile);
    return profile;
  }
}

export function createInMemoryPastoralistProfileRepository(
  seed: readonly PastoralistProfile[] = []
): InMemoryPastoralistProfileRepository {
  return new InMemoryPastoralistProfileRepository(seed);
}
