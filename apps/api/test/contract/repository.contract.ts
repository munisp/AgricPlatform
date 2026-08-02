import { describe, expect, it } from 'vitest';
import type { AsyncRepository } from '../../src/common/async-repository.js';

export interface RepositoryContractCase<T extends { id: string }, TCriteria> {
  /** Human-readable entity name for test titles. */
  name: string;
  /** Fresh repository instance per invocation. */
  make: () => AsyncRepository<T, TCriteria> | Promise<AsyncRepository<T, TCriteria>>;
  /** Two entities with unique ids; `primary` must match `matchCriteria`. */
  primary: () => T;
  secondary: () => T;
  /** Criteria that matches primary but not secondary. */
  matchCriteria: TCriteria;
  /** Patch applied to primary in the update test. */
  patch: Partial<T>;
  /** Assertion for the patched value. */
  assertPatched: (updated: T) => void;
}

/**
 * Shared repository contract (plan §9.3): the same suite runs against the
 * in-memory implementations always and against the pg implementations when
 * DATABASE_URL is set, keeping the two modes behaviourally identical.
 */
export function runRepositoryContract<T extends { id: string }, TCriteria>(
  testCase: RepositoryContractCase<T, TCriteria>
): void {
  describe(`${testCase.name} repository contract`, () => {
    it('creates and reads back by id', async () => {
      const repo = await testCase.make();
      const item = testCase.primary();
      await repo.create(item);
      expect(await repo.findById(item.id)).toEqual(item);
      expect(await repo.getById(item.id)).toEqual(item);
    });

    it('getById raises NotFound for unknown ids', async () => {
      const repo = await testCase.make();
      await expect(repo.getById('missing')).rejects.toThrow(/not found/i);
    });

    it('filters by criteria', async () => {
      const repo = await testCase.make();
      const primary = testCase.primary();
      const secondary = testCase.secondary();
      await repo.create(primary);
      await repo.create(secondary);
      const matches = await repo.find(testCase.matchCriteria);
      expect(matches.map((item) => item.id)).toContain(primary.id);
      expect(matches.map((item) => item.id)).not.toContain(secondary.id);
      expect(await repo.count(testCase.matchCriteria)).toBe(matches.length);
    });

    it('updates a record with a patch', async () => {
      const repo = await testCase.make();
      const item = testCase.primary();
      await repo.create(item);
      const updated = await repo.update(item.id, testCase.patch);
      expect(updated.id).toBe(item.id);
      testCase.assertPatched(updated);
    });

    it('removes records and reports the outcome', async () => {
      const repo = await testCase.make();
      const item = testCase.primary();
      await repo.create(item);
      expect(await repo.remove(item.id)).toBe(true);
      expect(await repo.remove(item.id)).toBe(false);
      expect(await repo.findById(item.id)).toBeUndefined();
    });
  });
}
