import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';

/**
 * Repository port. Each domain service depends on this interface so the
 * in-memory implementation can be replaced with a PostgreSQL-backed
 * repository (TypeORM/Prisma) without touching service logic.
 */
export interface Repository<T extends { id: string }> {
  all(): T[];
  find(predicate: (item: T) => boolean): T[];
  findOne(predicate: (item: T) => boolean): T | undefined;
  findById(id: string): T | undefined;
  getById(id: string): T;
  create(item: T): T;
  update(id: string, patch: Partial<T>): T;
  remove(id: string): boolean;
  count(predicate?: (item: T) => boolean): number;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Phase 1 in-memory repository. Data is seeded per module and lives for the
 * process lifetime. Production deployments swap this for PostgreSQL per
 * SPEC.md architecture contract 5.
 */
export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  protected readonly items = new Map<string, T>();

  constructor(seed: readonly T[] = []) {
    for (const item of seed) {
      this.items.set(item.id, structuredClone(item));
    }
  }

  all(): T[] {
    return [...this.items.values()];
  }

  find(predicate: (item: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  findOne(predicate: (item: T) => boolean): T | undefined {
    return this.all().find(predicate);
  }

  findById(id: string): T | undefined {
    return this.items.get(id);
  }

  getById(id: string): T {
    const item = this.findById(id);
    if (!item) {
      throw new NotFoundException(`Resource with id '${id}' not found`);
    }
    return item;
  }

  create(item: T): T {
    this.items.set(item.id, item);
    return item;
  }

  update(id: string, patch: Partial<T>): T {
    const current = this.getById(id);
    const next = { ...current, ...patch, id: current.id };
    this.items.set(id, next);
    return next;
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  count(predicate?: (item: T) => boolean): number {
    return predicate ? this.find(predicate).length : this.items.size;
  }
}
