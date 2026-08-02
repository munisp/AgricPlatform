import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ApiListResponse } from '@agric-platform/shared';
import type { AsyncRepository } from './async-repository.js';
import { paginate } from './pagination.js';

/** Builds a matcher that ANDs all provided field predicates. */
export function combineMatchers<T, TCriteria>(
  criteria: TCriteria,
  fields: Array<(criteria: TCriteria, item: T) => boolean>
): (item: T) => boolean {
  return (item) => fields.every((field) => field(criteria, item));
}

/** Case-insensitive substring match mirroring SQL ILIKE '%q%'. */
export function ilike(value: string | undefined, query: string): boolean {
  return value !== undefined && value.toLowerCase().includes(query.toLowerCase());
}

/**
 * In-memory repository implementing the async port (persistence wave plan
 * §2.2). Criteria objects are routed through the injected matcher so unit
 * tests exercise the same semantics the pg implementation compiles to SQL.
 * Data is seeded per module and lives for the process lifetime; production
 * deployments swap this for the pg implementation behind the same port.
 */
export class InMemoryRepository<T extends { id: string }, TCriteria = void>
  implements AsyncRepository<T, TCriteria>
{
  protected readonly items = new Map<string, T>();

  constructor(
    seed: readonly T[] = [],
    private readonly matcher?: (criteria: TCriteria) => (item: T) => boolean
  ) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  async all(): Promise<T[]> {
    return [...this.items.values()];
  }

  async find(criteria: TCriteria): Promise<T[]> {
    if (!this.matcher) {
      throw new Error('InMemoryRepository.find requires a criteria matcher');
    }
    return (await this.all()).filter(this.matcher(criteria));
  }

  async findOne(criteria: TCriteria): Promise<T | undefined> {
    return (await this.find(criteria))[0];
  }

  async findById(id: string): Promise<T | undefined> {
    return this.items.get(id);
  }

  async getById(id: string): Promise<T> {
    const item = await this.findById(id);
    if (!item) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return item;
  }

  async create(item: T): Promise<T> {
    this.items.set(item.id, item);
    return item;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const current = await this.getById(id);
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return next;
  }

  /**
   * Synchronous check-and-set mirroring the pg conditional UPDATE: the
   * precondition is verified and the patch applied without an intervening
   * await, so concurrent transitions serialise exactly like the guarded SQL.
   * The optional outbox event is NOT persisted here (no transactionalOutbox
   * marker); callers fall back to DomainEventsService.persist.
   */
  async updateExpected(id: string, patch: Partial<T>, expected: Partial<T>): Promise<T> {
    const current = await this.getById(id);
    for (const [key, value] of Object.entries(expected)) {
      if ((current as Record<string, unknown>)[key] !== value) {
        throw new ConflictException(
          `Concurrent state change on '${id}' (expected ${key}='${String(value)}', found '${String((current as Record<string, unknown>)[key])}'); retry the operation`
        );
      }
    }
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(criteria?: TCriteria): Promise<number> {
    return criteria !== undefined ? (await this.find(criteria)).length : this.items.size;
  }

  /** Filter + paginate helper shared by the list endpoints (plan §2.5.3). */
  async searchPage(
    criteria: TCriteria,
    page?: number,
    pageSize?: number
  ): Promise<ApiListResponse<T>> {
    return paginate(await this.find(criteria), page, pageSize);
  }
}
