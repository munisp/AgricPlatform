import type {
  Animal,
  AnimalCriteria,
  AnimalRepository,
  AnimalStatus,
  LivestockSpecies
} from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';
import { seedAnimals } from '../seed-data.js';

export type { AnimalCriteria };

export interface LivestockAnimalRepository extends AsyncRepository<Animal, AnimalCriteria> {
  countByOwner(ownerUserId: string): Promise<number>;
  /**
   * Species breakdown for the registry stats endpoint (GAP-L02 made it
   * repository-level so the pg driver aggregates in SQL).
   */
  countBySpecies(): Promise<Partial<Record<LivestockSpecies, number>>>;
  /**
   * CAS status transition (GAP-M16): flips status only when the row is in
   * `from`; returns the updated row, or undefined when the animal does not
   * exist or is not in the expected state (concurrent transition lost).
   */
  transitionStatus(id: string, from: AnimalStatus, to: AnimalStatus): Promise<Animal | undefined>;
}

export function animalMatcher(criteria: AnimalCriteria): (animal: Animal) => boolean {
  return (animal) =>
    (!criteria.ownerUserId || animal.ownerUserId === criteria.ownerUserId) &&
    (!criteria.species || animal.species === criteria.species) &&
    (!criteria.status || animal.status === criteria.status) &&
    (!criteria.state || animal.state === criteria.state) &&
    (!criteria.q ||
      animal.id.toLowerCase().includes(criteria.q.toLowerCase()) ||
      animal.breed.toLowerCase().includes(criteria.q.toLowerCase()) ||
      (animal.tagId ?? '').toLowerCase().includes(criteria.q.toLowerCase()));
}

export class InMemoryAnimalRepository
  extends InMemoryRepository<Animal, AnimalCriteria>
  implements LivestockAnimalRepository
{
  constructor(seed: readonly Animal[] = seedAnimals) {
    super(seed, animalMatcher);
  }

  async countByOwner(ownerUserId: string): Promise<number> {
    return (await this.find({ ownerUserId })).length;
  }

  async countBySpecies(): Promise<Partial<Record<LivestockSpecies, number>>> {
    const counts: Partial<Record<LivestockSpecies, number>> = {};
    for (const animal of await this.all()) {
      counts[animal.species] = (counts[animal.species] ?? 0) + 1;
    }
    return counts;
  }

  async transitionStatus(
    id: string,
    from: AnimalStatus,
    to: AnimalStatus
  ): Promise<Animal | undefined> {
    const existing = await this.findById(id);
    if (!existing || existing.status !== from) {
      return undefined;
    }
    return this.update(id, { status: to, updatedAt: new Date().toISOString() });
  }
}

export function createInMemoryAnimalRepository(
  seed: readonly Animal[] = seedAnimals
): InMemoryAnimalRepository {
  return new InMemoryAnimalRepository(seed);
}
