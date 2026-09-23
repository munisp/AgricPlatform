import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { PgOutboxRepository } from './core.pg-repository.js';
import {
  boundOutboxListLimit,
  InMemoryOutboxRepository,
  OUTBOX_LIST_DEFAULT_LIMIT,
  OUTBOX_LIST_MAX_LIMIT
} from './outbox.repository.js';
import type { DomainEvent } from '../../core/domain-events.service.js';

/**
 * P2 perf query-spy tests: outbox list reads are LIMIT-bounded (the table is
 * append-only and grew unboundedly) with an explicit, clamped parameter.
 */

interface QueryCall {
  text: string;
  params?: unknown[];
}

function spyPool(rows: Record<string, unknown>[] = []) {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

describe('boundOutboxListLimit', () => {
  it('defaults to OUTBOX_LIST_DEFAULT_LIMIT and clamps to [1, OUTBOX_LIST_MAX_LIMIT]', () => {
    expect(boundOutboxListLimit(undefined)).toBe(OUTBOX_LIST_DEFAULT_LIMIT);
    expect(boundOutboxListLimit(Number.NaN)).toBe(OUTBOX_LIST_DEFAULT_LIMIT);
    expect(boundOutboxListLimit(0)).toBe(1);
    expect(boundOutboxListLimit(-5)).toBe(1);
    expect(boundOutboxListLimit(50)).toBe(50);
    expect(boundOutboxListLimit(50.7)).toBe(50);
    expect(boundOutboxListLimit(OUTBOX_LIST_MAX_LIMIT + 1)).toBe(OUTBOX_LIST_MAX_LIMIT);
  });
});

describe('PgOutboxRepository bounded list reads', () => {
  it('list() applies the default LIMIT', async () => {
    const { pool, calls } = spyPool();
    const repo = new PgOutboxRepository(pool);

    await repo.list();

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('FROM events.outbox ORDER BY occurred_at LIMIT $1');
    expect(calls[0].params).toEqual([OUTBOX_LIST_DEFAULT_LIMIT]);
  });

  it('listRecords() honours an explicit (clamped) LIMIT', async () => {
    const { pool, calls } = spyPool();
    const repo = new PgOutboxRepository(pool);

    await repo.listRecords(25);
    expect(calls[0].text).toContain('LIMIT $1');
    expect(calls[0].params).toEqual([25]);

    await repo.listRecords(OUTBOX_LIST_MAX_LIMIT * 10);
    expect(calls[1].params).toEqual([OUTBOX_LIST_MAX_LIMIT]);
  });
});

describe('InMemoryOutboxRepository bounded list reads (contract parity)', () => {
  function event(id: string): DomainEvent {
    return {
      id,
      name: 'test.event',
      payload: {},
      occurredAt: '2026-01-01T00:00:00.000Z'
    } as DomainEvent;
  }

  it('list()/listRecords() return the oldest rows up to the bound', async () => {
    const repo = new InMemoryOutboxRepository();
    for (let index = 0; index < 5; index += 1) {
      await repo.append(event(`e-${index}`));
    }

    expect((await repo.list()).map((e) => e.id)).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4']);
    expect((await repo.list(2)).map((e) => e.id)).toEqual(['e-0', 'e-1']);
    expect((await repo.listRecords(3)).map((record) => record.event.id)).toEqual([
      'e-0',
      'e-1',
      'e-2'
    ]);
  });
});
