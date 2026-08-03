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
 * PostgreSQL parity suite for the sync protocol repositories (Wave SYNCSRV;
 * plan §9.3 contract pattern). Skipped unless DATABASE_URL points at a
 * database; the 024_sync.sql migration is applied idempotently by the suite
 * itself, so only identity.users (001_init.sql) must pre-exist for the
 * updated_by FK — updatedBy is left null here to avoid that dependency.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/sync.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'infra',
  'postgres',
  '024_sync.sql'
);

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM sync.entity_versions WHERE entity LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM sync.sync_cursors WHERE user_id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM sync.mutations WHERE user_id LIKE 'pgtest-%'`);
}

describePg('pg sync repositories (parity with in-memory)', () => {
  beforeAll(async () => {
    await pool!.query(readFileSync(MIGRATION, 'utf8'));
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

  it('listSince is owner-scoped and version-ordered; maxVersion matches', async () => {
    const versions = createPgEntityVersionRepository(pool!);
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-3', ownerId: 'pgtest-u1', updatedBy: null });
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-4', ownerId: 'pgtest-u1', updatedBy: null });
    await versions.bump({ entity: 'pgtest-note', entityId: 'n-5', ownerId: 'pgtest-u2', updatedBy: null });

    const rows = await versions.listSince('pgtest-note', 'pgtest-u1', 0, 10);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.ownerId === 'pgtest-u1')).toBe(true);
    const sorted = [...rows].sort((a, b) => a.version - b.version);
    expect(rows).toEqual(sorted);

    const max = await versions.maxVersion('pgtest-note', 'pgtest-u1');
    expect(max).toBe(rows[rows.length - 1].version);
    expect(await versions.maxVersion('pgtest-note', 'pgtest-nobody')).toBe(0);
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
});
