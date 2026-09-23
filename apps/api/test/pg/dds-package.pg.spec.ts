import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictException, NotFoundException } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgDdsPackageRepository } from '../../src/database/repositories/dds-package.pg-repository.js';
import type { DdsPackage } from '../../src/database/repositories/dds-package.repository.js';

/**
 * PostgreSQL contract suite for DDS Studio packages (stage 27 innovation 17;
 * migration 076). Skipped unless DATABASE_URL points at a database;
 * migrations are applied idempotently by the suite itself (this doubles as
 * the "migration applies" check). The shipment FK requires
 * traceability.shipments (030) whose lots require identity.users (001), so
 * pgtest rows are upserted first.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/dds-package.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = [
  '029_traceability.sql',
  '030_traceability_dds.sql',
  '076_traceability_dds_packages.sql'
].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

const OWNER = 'pgtest-dds-user';

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM traceability.dds_packages WHERE id LIKE 'pgtest-dds-%'`);
  await pool!.query(`DELETE FROM traceability.shipment_lots WHERE id LIKE 'pgtest-dds-%'`);
  await pool!.query(`DELETE FROM traceability.shipments WHERE id LIKE 'pgtest-dds-%'`);
  await pool!.query(`DELETE FROM traceability.lot_plot_links WHERE id LIKE 'pgtest-dds-%'`);
  await pool!.query(`DELETE FROM traceability.custody_events WHERE id LIKE 'pgtest-dds-%'`);
  await pool!.query(`DELETE FROM traceability.commodity_lots WHERE id LIKE 'pgtest-dds-%'`);
}

function makePackage(id: string, overrides: Partial<DdsPackage> = {}): DdsPackage {
  return {
    id,
    shipmentId: 'pgtest-dds-sh-1',
    status: 'draft',
    checklist: [],
    createdBy: OWNER,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides
  };
}

describePg('pg dds packages (guarded status CAS / immutability after export)', () => {
  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, '+2340000000001', 'pg dds test']
    );
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
    await pool!.query(
      `INSERT INTO traceability.commodity_lots
         (id, owner_user_id, crop, harvest_window_start, harvest_window_end, quantity, unit)
       VALUES ('pgtest-dds-lot-1', $1, 'Cocoa', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', 500, 'kg')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER]
    );
    await pool!.query(
      `INSERT INTO traceability.shipments (id, creator_id, creator_kind, reference)
       VALUES ('pgtest-dds-sh-1', $1, 'user', 'EXP-PG-1') ON CONFLICT (id) DO NOTHING`,
      [OWNER]
    );
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.end();
    }
  });

  it('applies migration 076 idempotently', async () => {
    const sql = readFileSync(MIGRATIONS[2], 'utf8');
    await pool!.query(sql); // second apply must not throw
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'traceability' AND table_name = 'dds_packages'`
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('round-trips a draft package (checklist jsonb preserved)', async () => {
    const repo = createPgDdsPackageRepository(pool!);
    await repo.create(
      makePackage('pgtest-dds-1', {
        checklist: [{ requirement: 'shipment_has_lots', passed: true, basis: 'one lot bundled' }],
        exporterPartnerId: 'acme-export'
      })
    );
    const loaded = await repo.getById('pgtest-dds-1');
    expect(loaded.status).toBe('draft');
    expect(loaded.checklist).toEqual([
      { requirement: 'shipment_has_lots', passed: true, basis: 'one lot bundled' }
    ]);
    expect(loaded.exporterPartnerId).toBe('acme-export');
    expect(loaded.packageHash).toBeUndefined();
  });

  it('guarded CAS: a draft cannot be marked exported (never auto-passed)', async () => {
    const repo = createPgDdsPackageRepository(pool!);
    await repo.create(makePackage('pgtest-dds-2'));
    await expect(
      repo.markExported('pgtest-dds-2', 'a'.repeat(64), '2026-03-02T00:00:00.000Z')
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await repo.getById('pgtest-dds-2')).status).toBe('draft');
  });

  it('validated → exported CAS succeeds exactly once; replay conflicts', async () => {
    const repo = createPgDdsPackageRepository(pool!);
    await repo.create(makePackage('pgtest-dds-3'));
    await repo.saveChecklist('pgtest-dds-3', 'validated', [
      { requirement: 'custody_chain_continuity', passed: true, basis: 'chain recomputes cleanly' }
    ]);
    const exported = await repo.markExported('pgtest-dds-3', 'b'.repeat(64), '2026-03-02T00:00:00.000Z');
    expect(exported.status).toBe('exported');
    expect(exported.packageHash).toBe('b'.repeat(64));
    expect(exported.exportedAt).toBe('2026-03-02T00:00:00.000Z');
    // Package immutability after export: every further write conflicts.
    await expect(
      repo.markExported('pgtest-dds-3', 'c'.repeat(64), '2026-03-03T00:00:00.000Z')
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(repo.saveChecklist('pgtest-dds-3', 'draft', [])).rejects.toBeInstanceOf(
      ConflictException
    );
    const persisted = await repo.getById('pgtest-dds-3');
    expect(persisted.packageHash).toBe('b'.repeat(64));
    expect(persisted.checklist).toHaveLength(1);
  });

  it('a failed validation can be re-validated (draft → draft) before export', async () => {
    const repo = createPgDdsPackageRepository(pool!);
    await repo.create(makePackage('pgtest-dds-4'));
    await repo.saveChecklist('pgtest-dds-4', 'draft', [
      {
        requirement: 'lot_geolocation_snapshot',
        passed: false,
        basis: 'no linked production plot',
        missing: ['lot:pgtest-dds-lot-1:plot_snapshot']
      }
    ]);
    const revalidated = await repo.saveChecklist('pgtest-dds-4', 'validated', [
      { requirement: 'lot_geolocation_snapshot', passed: true, basis: 'snapshot linked' }
    ]);
    expect(revalidated.status).toBe('validated');
    expect(revalidated.checklist[0].passed).toBe(true);
  });

  it('unknown ids raise NotFoundException on the guarded paths', async () => {
    const repo = createPgDdsPackageRepository(pool!);
    await expect(repo.saveChecklist('pgtest-dds-missing', 'draft', [])).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      repo.markExported('pgtest-dds-missing', 'd'.repeat(64), '2026-03-02T00:00:00.000Z')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
