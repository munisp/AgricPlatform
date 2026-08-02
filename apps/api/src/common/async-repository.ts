import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../core/domain-events.service.js';

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
  /**
   * True when updateExpected persists a passed outbox event in the same
   * database transaction as the state change (PostgreSQL implementations).
   * Absent/false for in-memory implementations.
   */
  readonly transactionalOutbox?: boolean;
  all(): Promise<T[]>;
  find(criteria: TCriteria): Promise<T[]>;
  findOne(criteria: TCriteria): Promise<T | undefined>;
  findById(id: string): Promise<T | undefined>;
  /** Throws NotFoundException when the id does not exist. */
  getById(id: string): Promise<T>;
  create(item: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
  /**
   * Compare-and-set update (funds-integrity wave): applies `patch` only when
   * every field in `expected` still matches the stored row. Throws
   * NotFoundException when the id does not exist and ConflictException when
   * the precondition no longer holds (a concurrent transition won the race —
   * the caller should re-read and retry or surface the 409).
   *
   * When `outboxEvent` is passed and the implementation sets
   * `transactionalOutbox` (the pg base), the state change and the outbox
   * append commit in ONE database transaction, eliminating the dual-write
   * window. In-memory implementations ignore `outboxEvent`; callers must
   * then persist the event via DomainEventsService.persist themselves.
   */
  updateExpected(
    id: string,
    patch: Partial<T>,
    expected: Partial<T>,
    outboxEvent?: DomainEvent
  ): Promise<T>;
  remove(id: string): Promise<boolean>;
  count(criteria?: TCriteria): Promise<number>;
}
