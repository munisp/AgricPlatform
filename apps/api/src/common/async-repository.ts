import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Async repository port (persistence wave, plan §2.1). Every domain service
 * depends on a per-domain extension of this interface with a typed criteria
 * object; predicates never cross the port boundary. The in-memory
 * implementation receives a `matcher: (criteria) => (item) => boolean` so
 * unit tests keep full fidelity without SQL, and the PostgreSQL
 * implementation compiles the same criteria into whitelisted WHERE
 * fragments.
 */
export interface AsyncRepository<T extends { id: string }, TCriteria = void> {
  all(): Promise<T[]>;
  find(criteria: TCriteria): Promise<T[]>;
  findOne(criteria: TCriteria): Promise<T | undefined>;
  findById(id: string): Promise<T | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getById(id: string): Promise<T>;
  create(item: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
  remove(id: string): Promise<boolean>;
  count(criteria?: TCriteria): Promise<number>;
}
