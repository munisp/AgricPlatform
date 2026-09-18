import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgEntityVersionRepository,
  createPgSyncCursorRepository,
  createPgSyncMutationRepository
} from '../../src/database/repositories/sync.pg-repository.js';

/**
 * PostgreSQL parity suite for the sync protocol repositories (Wave SYNCSRV +
 * FP-4 v2; plan §9.3 contract pattern). Skipped unless DATABASE_URL points at
 * a database; the 024_sync.sql + 080_sync_change_seq.sql migrations are
 * applied idempotently by the suite itself, so only identity.users
 * (001_init.sql) must pre-exist for the updated_by FK — updatedBy is left
 * null here to avoid that dependency.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/sync.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = ['024_sync.sql', '080_sync_change_seq.sql'].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM sync.entity_versions WHERE entity LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM sync.sync_cursors WHERE user_id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM sync.mutations WHERE user_id LIKE 'pgtest-%'`);
}

describePg('pg sync repositories (parity with in-memory)', () => {
  beforeAll(async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
  });

  afterAll(async () => {
    await clean();
    await pool!.end();
  });

  it('bump inserts v1 then increments atomically', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = { entity: 'pgtest-note', entityId: 'n-1', ownerId: 'pgtest-u1', updatedBy: null };
    expect(await versions.bump(bump)).toBe(1);
    expect(await versions.bump(bump)).toBe(2);
    const row = await versions.current('pgtest-note', 'n-1');
    expect(row).toMatchObject({ version: 2, ownerId: 'pgtest-u1', deleted: false });
  });

  it('bumpExpected CAS: insert at 0, reject stale, advance on match', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = { entity: 'pgtest-note', entityId: 'n-2', ownerId: 'pgtest-u1', updatedBy: null };
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 1 })).toBeNull();
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 0 })).toBe(1);
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 0 })).toBeNull();
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 1, deleted: true })).toBe(2);
    expect((await versions.current('pgtest-note', 'n-2'))!.deleted).toBe(true);
  });

  it('listSince is owner-scoped and change_seq-ordered; maxChangeSeq matches', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-3', ownerId: 'pgtest-u1', updatedBy: null });
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-4', ownerId: 'pgtest-u1', updatedBy: null });
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-5', ownerId: 'pgtest-u2', updatedBy: null });

    const rows = await versions.listSince('pgtest-note', 'pgtest-u1', 0, 10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.ownerId === 'pgtest-u1')).toBe(true);
    const sorted = [...rows].sort((a, b) => a.changeSeq - b.changeSeq);
    expect(rows).toEqual(sorted);

    const max = await versions.maxChangeSeq('pgtest-note', 'pgtest-u1');
    expect(max).toBe(rows[rows.length - 1].changeSeq);
    expect(await versions.maxChangeSeq('pgtest-note', 'pgtest-nobody')).toBe(0);
  });

  it('V-01 walkthrough on pg: editing B after A hit v5 is still pulled since=5', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = (entityId: string) => ({
      entity: 'pgtest-v01',
      entityId,
      ownerId: 'pgtest-u1',
      updatedBy: null
    });
    for (let i = 0; i < 5; i += 1) {
      await versions.bump(bump('a')); // A → version 5
    }
    await versions.bump(bump('b')); // B → version 1
    await versions.bump(bump('b')); // B → version 2

    const a = (await versions.current('pgtest-v01', 'a'))!;
    // since = A's change_seq: v1 semantics (version > 5) lost B; v2 delivers it.
    const rows = await versions.listSince('pgtest-v01', 'pgtest-u1', a.changeSeq, 10);
    expect(rows.map((row) => [row.entityId, row.version])).toEqual([['b', 2]]);
  });

  it('applyGuarded: the loser never runs its apply; winner commits version + value', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = { entity: 'pgtest-guard', entityId: 'g-1', ownerId: 'pgtest-u1', updatedBy: null };
    await versions.bump(bump); // v1
    const first = await versions.applyGuarded({ ...bump, expectedVersion: 1 }, async () => 'won');
    expect(first).toEqual({ version: 2, value: 'won' });

    let loserRan = false;
    const lost = await versions.applyGuarded({ ...bump, expectedVersion: 1 }, async () => {
      loserRan = true;
    });
    expect(lost).toBeNull();
    expect(loserRan).toBe(false);
    expect((await versions.current('pgtest-guard', 'g-1'))!.version).toBe(2);
  });

  it('applyGuarded rolls the claim back when apply throws (ledger never ahead)', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = { entity: 'pgtest-guard', entityId: 'g-2', ownerId: 'pgtest-u1', updatedBy: null };
    await versions.bump(bump); // v1
    await expect(
      versions.applyGuarded({ ...bump, expectedVersion: 1 }, async () => {
        throw new Error('entity write failed');
      })
    ).rejects.toThrow('entity write failed');
    expect((await versions.current('pgtest-guard', 'g-2'))!.version).toBe(1);
  });

  it('applyGuarded serializes concurrent claimants: exactly one applies', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    const bump = { entity: 'pgtest-guard', entityId: 'g-3', ownerId: 'pgtest-u1', updatedBy: null };
    await versions.bump(bump); // v1
    const applied: string[] = [];
    const race = (name: string) =>
      versions.applyGuarded({ ...bump, expectedVersion: 1 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        applied.push(name);
      });
    const [r1, r2] = await Promise.all([race('one'), race('two')]);
    expect([r1, r2].filter((r) => r !== null)).toHaveLength(1);
    expect([r1, r2].filter((r) => r === null)).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect((await versions.current('pgtest-guard', 'g-3'))!.version).toBe(2);
  });

  it('cursor set is monotonic (GREATEST) per (user, entity)', async () => {
    const cursors = createPgSyncCursorRepository(pool!);
    expect(await cursors.get('pgtest-u1', 'pgtest-note')).toBe(0);
    await cursors.set('pgtest-u1', 'pgtest-note', 5);
    await cursors.set('pgtest-u1', 'pgtest-note', 3); // regression ignored
    expect(await cursors.get('pgtest-u1', 'pgtest-note')).toBe(5);
    await cursors.set('pgtest-u1', 'pgtest-note', 9);
    expect(await cursors.get('pgtest-u1', 'pgtest-note')).toBe(9);
  });

  it('stale v1 cursor rows (protocol=1) read as 0 under v2', async () => {
    const cursors = createPgSyncCursorRepository(pool!);
    // Simulate a pre-080 row: cursor recorded under protocol v1.
    await pool!.query(
      `INSERT INTO sync.sync_cursors (user_id, entity, cursor, protocol, updated_at)
       VALUES ('pgtest-u1', 'pgtest-legacy', 42, 1, now())
       ON CONFLICT (user_id, entity) DO UPDATE SET cursor = 42, protocol = 1`
    );
    expect(await cursors.get('pgtest-u1', 'pgtest-legacy')).toBe(0);
    // The next v2 pull stamps protocol 2 and the cursor reads normally.
    await cursors.set('pgtest-u1', 'pgtest-legacy', 7);
    expect(await cursors.get('pgtest-u1', 'pgtest-legacy')).toBe(7);
  });

  it('mutation ledger record is atomic and replayable', async () => {
    const mutations = createPgSyncMutationRepository(pool!);
    const record = {
      userId: 'pgtest-u1',
      clientMutationId: 'm-1',
      entity: 'pgtest-note',
      entityId: 'n-1',
      op: 'upsert' as const,
      status: 'applied' as const,
      newVersion: 1,
      detail: { status: 'applied', newVersion: 1 },
      createdAt: new Date().toISOString()
    };
    expect(await mutations.record(record)).toBe(true);
    expect(await mutations.record({ ...record, newVersion: 99 })).toBe(false);
    const found = await mutations.find('pgtest-u1', 'm-1');
    expect(found).toMatchObject({ status: 'applied', newVersion: 1, op: 'upsert' });
    expect(await mutations.find('pgtest-u1', 'm-missing')).toBeUndefined();
  });

  it('pruneOlderThan removes only stale rows, oldest first, capped by limit (L-09)', async () => {
    const mutations = createPgSyncMutationRepository(pool!);
    const record = (id: string, createdAt: string) => ({
      userId: 'pgtest-u1',
      clientMutationId: id,
      entity: 'pgtest-note',
      entityId: 'n-1',
      op: 'upsert' as const,
      status: 'applied' as const,
      newVersion: 1,
      detail: null,
      createdAt
    });
    await mutations.record(record('old-1', '2020-01-01T00:00:00.000Z'));
    await mutations.record(record('old-2', '2020-06-01T00:00:00.000Z'));
    await mutations.record(record('fresh', '2999-01-01T00:00:00.000Z'));
    // record() lets created_at default to now(); age the two stale rows directly.
    await pool!.query(
      `UPDATE sync.mutations SET created_at = '2020-01-01T00:00:00Z'
        WHERE user_id = 'pgtest-u1' AND client_mutation_id = 'old-1'`
    );
    await pool!.query(
      `UPDATE sync.mutations SET created_at = '2020-06-01T00:00:00Z'
        WHERE user_id = 'pgtest-u1' AND client_mutation_id = 'old-2'`
    );

    // Cap of 1 prunes only the oldest stale row.
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 1)).toBe(1);
    expect(await mutations.find('pgtest-u1', 'old-1')).toBeUndefined();
    expect(await mutations.find('pgtest-u1', 'old-2')).toBeDefined();
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 100)).toBe(1);
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 100)).toBe(0);
    expect(await mutations.find('pgtest-u1', 'fresh')).toBeDefined();
  });
});
