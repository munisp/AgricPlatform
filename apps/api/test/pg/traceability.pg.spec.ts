import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgCommodityLotRepository,
  createPgCustodyEventRepository,
  createPgLotPlotLinkRepository,
  createPgTraceabilityShipmentRepository
} from '../../src/database/repositories/traceability.pg-repository.js';
import { computeEventHash, GENESIS_PREV_HASH, hashPayloadOf } from '../../src/modules/traceability/traceability.types.js';

/**
 * PostgreSQL parity suite for the traceability repositories (wave-eudr;
 * plan §9.3 contract pattern). Skipped unless DATABASE_URL points at a
 * database; migrations 029/030 are applied idempotently by the suite itself
 * (this doubles as the "migration applies" check). The commodity_lots
 * owner FK requires identity.users (001_init.sql), so a pgtest user row is
 * upserted first.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/agricplatform \
 *     npx vitest run test/pg/traceability.pg.spec.ts
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const MIGRATIONS = ['029_traceability.sql', '030_traceability_dds.sql'].map((file) =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'postgres', file)
);

const OWNER = 'pgtest-trace-user';

async function clean(): Promise<void> {
  await pool!.query(`DELETE FROM traceability.shipment_lots WHERE id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM traceability.shipments WHERE id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM traceability.lot_plot_links WHERE id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM traceability.custody_events WHERE id LIKE 'pgtest-%'`);
  await pool!.query(`DELETE FROM traceability.commodity_lots WHERE id LIKE 'pgtest-%'`);
}

describePg('pg traceability repositories (parity with in-memory)', () => {
  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO identity.users (id, phone, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, '+2340000000000', 'pg traceability test']
    );
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8'));
    }
    await clean();
  });

  afterAll(async () => {
    if (pool) {
      await clean();
      await pool.end();
    }
  });

  it('applies migrations 029/030 idempotently', async () => {
    for (const migration of MIGRATIONS) {
      await pool!.query(readFileSync(migration, 'utf8')); // second apply must not throw
    }
    const tables = await pool!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'traceability' ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'commodity_lots',
      'custody_events',
      'lot_plot_links',
      'shipment_lots',
      'shipments'
    ]);
  });

  it('round-trips a lot, its custody chain and a plot snapshot', async () => {
    const lots = createPgCommodityLotRepository(pool!);
    const custody = createPgCustodyEventRepository(pool!);
    const links = createPgLotPlotLinkRepository(pool!);
    const now = new Date().toISOString();
    await lots.create({
      id: 'pgtest-lot-1',
      ownerUserId: OWNER,
      crop: 'Cocoa',
      harvestWindowStart: now,
      harvestWindowEnd: now,
      quantity: 100,
      unit: 'kg',
      status: 'active',
      parentLotIds: [],
      createdAt: now,
      updatedAt: now
    });
    const unsigned = {
      lotId: 'pgtest-lot-1',
      seq: 0,
      type: 'CREATED' as const,
      actorId: OWNER,
      occurredAt: now,
      latitude: 11.0855,
      longitude: 7.7199,
      parentLotIds: [],
      prevEventHash: GENESIS_PREV_HASH
    };
    await custody.append({
      id: 'pgtest-evt-1',
      ...unsigned,
      eventHash: computeEventHash(hashPayloadOf(unsigned)),
      createdAt: now
    });
    await links.create({
      id: 'pgtest-lpl-1',
      lotId: 'pgtest-lot-1',
      plotId: 'pgtest-plot-1',
      plotOwnerUserId: OWNER,
      plotName: 'Zaria North',
      latitude: 11.0855,
      longitude: 7.7199,
      linkedAt: now,
      linkedBy: OWNER
    });
    expect((await lots.getById('pgtest-lot-1')).crop).toBe('Cocoa');
    expect(await custody.countByLot('pgtest-lot-1')).toBe(1);
    expect((await custody.listByLot('pgtest-lot-1'))[0].prevEventHash).toBe(GENESIS_PREV_HASH);
    expect((await links.find({ lotId: 'pgtest-lot-1' }))[0].latitude).toBeCloseTo(11.0855);
  });

  it('enforces event_hash uniqueness at the database level', async () => {
    const lots = createPgCommodityLotRepository(pool!);
    const custody = createPgCustodyEventRepository(pool!);
    const now = new Date().toISOString();
    await lots.create({
      id: 'pgtest-lot-2',
      ownerUserId: OWNER,
      crop: 'Cocoa',
      harvestWindowStart: now,
      harvestWindowEnd: now,
      quantity: 50,
      unit: 'kg',
      status: 'active',
      parentLotIds: [],
      createdAt: now,
      updatedAt: now
    });
    const unsigned = {
      lotId: 'pgtest-lot-2',
      seq: 0,
      type: 'CREATED' as const,
      actorId: OWNER,
      occurredAt: now,
      latitude: 1,
      longitude: 2,
      parentLotIds: [],
      prevEventHash: GENESIS_PREV_HASH
    };
    const event = {
      id: 'pgtest-evt-2',
      ...unsigned,
      eventHash: computeEventHash(hashPayloadOf(unsigned)),
      createdAt: now
    };
    await custody.append(event);
    await expect(custody.append({ ...event, id: 'pgtest-evt-3' })).rejects.toBeInstanceOf(Error);
  });

  it('creates a shipment with its lot composition transactionally', async () => {
    const lots = createPgCommodityLotRepository(pool!);
    const shipments = createPgTraceabilityShipmentRepository(pool!);
    const now = new Date().toISOString();
    await lots.create({
      id: 'pgtest-lot-3',
      ownerUserId: OWNER,
      crop: 'Sesame',
      harvestWindowStart: now,
      harvestWindowEnd: now,
      quantity: 10,
      unit: 'kg',
      status: 'active',
      parentLotIds: [],
      createdAt: now,
      updatedAt: now
    });
    await shipments.create(
      {
        id: 'pgtest-tsh-1',
        creatorId: `partner:${OWNER}`,
        creatorKind: 'partner',
        status: 'created',
        createdAt: now,
        updatedAt: now
      },
      [{ id: 'pgtest-tsl-1', shipmentId: 'pgtest-tsh-1', lotId: 'pgtest-lot-3', position: 0 }]
    );
    expect((await shipments.listLots('pgtest-tsh-1'))[0].lotId).toBe('pgtest-lot-3');
    await shipments.updateStatus('pgtest-tsh-1', 'exported');
    expect((await shipments.getById('pgtest-tsh-1')).status).toBe('exported');
  });
});
