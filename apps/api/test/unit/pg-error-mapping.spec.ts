import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { mapPgError, PgRepositoryBase } from '../../src/database/pg/pg-repository.base.js';

/**
 * V-70: malformed client input reaching the pg driver (22P02 invalid text
 * representation, 22003 numeric out of range, 22007 invalid datetime) must
 * surface as 400 Bad Request — never as an unmapped 500.
 */

function pgError(code: string): Error & { code: string } {
  const error = new Error(`simulated pg failure ${code}`) as Error & { code: string };
  error.code = code;
  return error;
}

/** Failing pool: every query rejects with the given pg error. */
function failingPool(error: unknown): pg.Pool {
  return {
    query: () => Promise.reject(error)
  } as unknown as pg.Pool;
}

interface Widget {
  id: string;
  name: string;
}

class WidgetRepository extends PgRepositoryBase<Widget, { name?: string }> {
  constructor(pool: pg.Pool) {
    super(pool, {
      table: 'public.widgets',
      orderBy: 'id',
      mapper: {
        columns: ['id', 'name'],
        toRow: (w) => ({ id: w.id, name: w.name }),
        fromRow: (row) => ({ id: row.id as string, name: row.name as string })
      }
    });
  }

  protected override where(criteria: { name?: string }) {
    return criteria.name
      ? { where: ' WHERE name = $1', params: [criteria.name] }
      : { where: '', params: [] };
  }
}

describe('mapPgError (V-70)', () => {
  it('maps 22P02 / 22003 / 22007 to BadRequestException', () => {
    for (const code of ['22P02', '22003', '22007']) {
      expect(() => mapPgError(pgError(code))).toThrowError(BadRequestException);
    }
  });

  it('keeps the pre-existing mappings and rethrows unknown codes raw', () => {
    expect(() => mapPgError(pgError('23505'))).toThrowError(/unique values/);
    expect(() => mapPgError(pgError('23503'))).toThrowError(/does not exist/);
    expect(() => mapPgError(pgError('57014'))).toThrowError(/simulated pg failure 57014/);
  });
});

describe('PgRepositoryBase read/write paths (V-70)', () => {
  it('findById with a malformed uuid → 400, not a raw 22P02 passthrough', async () => {
    const repo = new WidgetRepository(failingPool(pgError('22P02')));
    await expect(repo.findById('not-a-uuid')).rejects.toThrowError(BadRequestException);
  });

  it('find / findOne / all / searchPage / count map driver syntax errors to 400', async () => {
    const repo = new WidgetRepository(failingPool(pgError('22007')));
    await expect(repo.find({})).rejects.toThrowError(BadRequestException);
    await expect(repo.findOne({})).rejects.toThrowError(BadRequestException);
    await expect(repo.all()).rejects.toThrowError(BadRequestException);
    await expect(repo.searchPage({}, 1, 10)).rejects.toThrowError(BadRequestException);
    await expect(repo.count()).rejects.toThrowError(BadRequestException);
  });

  it('update and remove map driver errors to 400', async () => {
    const repo = new WidgetRepository(failingPool(pgError('22P02')));
    await expect(repo.update('x', { name: 'y' } as Partial<Widget>)).rejects.toThrowError(
      BadRequestException
    );
    await expect(repo.remove('not-a-uuid')).rejects.toThrowError(BadRequestException);
  });

  it('non-mapping driver errors propagate unchanged (fail loudly)', async () => {
    const repo = new WidgetRepository(failingPool(pgError('53300')));
    await expect(repo.findById('anything')).rejects.toThrowError(/simulated pg failure 53300/);
  });
});
