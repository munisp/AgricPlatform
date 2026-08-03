import type { GeoBoundary, GeoBoundaryKind, H3IndexEntry, H3Resolution } from '@agric-platform/shared';
import type { AsyncRepository } from '../../common/async-repository.js';
import { InMemoryRepository } from '../../common/in-memory.repository.js';

/**
 * Geospatial pack persistence ports (Wave GEO, geo schema, migration 026).
 * No PostGIS: the H3 index is a plain table keyed (entity, entity_id) with
 * precomputed res-5/7/9 cells; the pg implementation mirrors these exact
 * in-memory semantics behind the DatabaseModule factories.
 */

/** Column holding the cell for a given indexed resolution. */
export const H3_RESOLUTION_COLUMNS: Record<H3Resolution, keyof H3IndexEntry> = {
  5: 'h3Res5',
  7: 'h3Res7',
  9: 'h3Res9'
};

export interface H3IndexCriteria {
  entity?: string;
  entityId?: string;
  h3Res5?: string;
  h3Res7?: string;
  h3Res9?: string;
}

/**
 * H3 index port. Deliberately NOT the generic AsyncRepository: the primary
 * key is the (entity, entityId) pair and writes are idempotent upserts so
 * reindex runs and duplicate domain-event deliveries stay safe.
 */
export interface H3IndexRepository {
  /** Insert-or-replace keyed by (entity, entityId); reindex-safe. */
  upsert(entry: H3IndexEntry): Promise<H3IndexEntry>;
  find(criteria: H3IndexCriteria): Promise<H3IndexEntry[]>;
  /** Entries of `entity` whose cell at `resolution` is in `cells`. */
  findByCells(
    entity: string,
    resolution: H3Resolution,
    cells: readonly string[]
  ): Promise<H3IndexEntry[]>;
  removeByEntity(entity: string, entityId: string): Promise<boolean>;
  count(criteria?: H3IndexCriteria): Promise<number>;
}

export function h3IndexKey(entity: string, entityId: string): string {
  return `${entity}:${entityId}`;
}

export function h3IndexMatcher(criteria: H3IndexCriteria): (entry: H3IndexEntry) => boolean {
  return (entry) =>
    (!criteria.entity || entry.entity === criteria.entity) &&
    (!criteria.entityId || entry.entityId === criteria.entityId) &&
    (!criteria.h3Res5 || entry.h3Res5 === criteria.h3Res5) &&
    (!criteria.h3Res7 || entry.h3Res7 === criteria.h3Res7) &&
    (!criteria.h3Res9 || entry.h3Res9 === criteria.h3Res9);
}

export class InMemoryH3IndexRepository implements H3IndexRepository {
  private readonly items = new Map<string, H3IndexEntry>();

  constructor(seed: readonly H3IndexEntry[] = []) {
    for (const entry of seed) {
      this.items.set(h3IndexKey(entry.entity, entry.entityId), structuredClone(entry));
    }
  }

  async upsert(entry: H3IndexEntry): Promise<H3IndexEntry> {
    const stored = structuredClone(entry);
    this.items.set(h3IndexKey(entry.entity, entry.entityId), stored);
    return stored;
  }

  async find(criteria: H3IndexCriteria): Promise<H3IndexEntry[]> {
    return [...this.items.values()].filter(h3IndexMatcher(criteria));
  }

  async findByCells(
    entity: string,
    resolution: H3Resolution,
    cells: readonly string[]
  ): Promise<H3IndexEntry[]> {
    const column = H3_RESOLUTION_COLUMNS[resolution];
    const wanted = new Set(cells);
    return [...this.items.values()].filter(
      (entry) => entry.entity === entity && wanted.has(entry[column] as string)
    );
  }

  async removeByEntity(entity: string, entityId: string): Promise<boolean> {
    return this.items.delete(h3IndexKey(entity, entityId));
  }

  async count(criteria: H3IndexCriteria = {}): Promise<number> {
    return (await this.find(criteria)).length;
  }
}

export function createInMemoryH3IndexRepository(
  seed: readonly H3IndexEntry[] = []
): InMemoryH3IndexRepository {
  return new InMemoryH3IndexRepository(seed);
}

// ---------------------------------------------------------------------------

export interface GeoBoundaryCriteria {
  kind?: GeoBoundaryKind;
  parentId?: string;
}

export interface GeoBoundaryRepository
  extends AsyncRepository<GeoBoundary, GeoBoundaryCriteria> {}

export function geoBoundaryMatcher(
  criteria: GeoBoundaryCriteria
): (boundary: GeoBoundary) => boolean {
  return (boundary) =>
    (!criteria.kind || boundary.kind === criteria.kind) &&
    (!criteria.parentId || boundary.parentId === criteria.parentId);
}

export class InMemoryGeoBoundaryRepository
  extends InMemoryRepository<GeoBoundary, GeoBoundaryCriteria>
  implements GeoBoundaryRepository
{
  constructor(seed: readonly GeoBoundary[] = []) {
    super(seed, geoBoundaryMatcher);
  }
}

export function createInMemoryGeoBoundaryRepository(
  seed: readonly GeoBoundary[] = []
): InMemoryGeoBoundaryRepository {
  return new InMemoryGeoBoundaryRepository(seed);
}
