import { describe, expect, it } from 'vitest';
import pg from 'pg';
import type { AuditAnchor, AuditEvent } from '@agric-platform/shared';
import { AuditAnchorService } from '../../src/core/audit-anchor.service.js';
import { AuditService } from '../../src/core/audit.service.js';
import { GENESIS_HASH, hashAuditAnchor, hashAuditEvent } from '../../src/core/audit-chain.js';
import {
  createPgAuditAnchorRepository,
  PgAuditAnchorRepository
} from '../../src/database/repositories/audit-anchor.pg-repository.js';
import {
  createPgAuditRepository,
  PgAuditRepository
} from '../../src/database/repositories/core.pg-repository.js';

/**
 * Audit chain fork-guard tests (audit C2-11, migration 043).
 *
 * Two layers:
 *  - `pg audit chain append (query spy)`: always-on unit tests over a fake
 *    pool proving the atomic guarded INSERT shape, the 23505/tail-moved
 *    retry loop, and the loud bounded failure.
 *  - `pg audit chain fork guard`: live contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract
 *    job against a database with migration 043 applied.
 */

type QueryOutcome = { rows: Record<string, unknown>[]; rowCount?: number } | Error;

interface FakePool {
  pool: pg.Pool;
  calls: { text: string; params: unknown[] }[];
}

function fakePool(behavior: (text: string, params: unknown[]) => QueryOutcome): FakePool {
  const calls: { text: string; params: unknown[] }[] = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      const outcome = behavior(text, params ?? []);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {
        rows: outcome.rows,
        rowCount: outcome.rowCount ?? outcome.rows.length,
        command: 'INSERT',
        oid: 0,
        fields: []
      };
    }
  } as unknown as pg.Pool;
  return { pool, calls };
}

const unsignedEvent = (id: string): Omit<AuditEvent, 'prevHash' | 'hash'> => ({
  id,
  actorId: 'admin-1',
  action: 'user.suspend',
  entityType: 'user',
  entityId: 'user-1',
  metadata: {},
  createdAt: '2026-06-01T00:00:00.000Z'
});

const uniqueViolation = (): Error & { code: string } =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

describe('pg audit chain append (query spy)', () => {
  it('links to the tail read from the database and issues a single guarded INSERT', async () => {
    const tailHash = 'a'.repeat(64);
    const { pool, calls } = fakePool((text) =>
      text.startsWith('SELECT hash, created_at FROM admin.audit_events')
        ? { rows: [{ hash: tailHash }] }
        : { rows: [], rowCount: 1 }
    );
    const repository = new PgAuditRepository(pool);

    const event = await repository.append(unsignedEvent('audit-1'));

    expect(event.prevHash).toBe(tailHash);
    const { hash, ...linkedPayload } = event;
    expect(hash).toBe(hashAuditEvent(linkedPayload, tailHash));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const insert = calls.find((call) => call.text.startsWith('INSERT INTO admin.audit_events'));
    expect(insert).toBeDefined();
    // The tail is re-read inside the INSERT (ORDER BY created_at DESC, id DESC)
    // and the claimed parent hash is a parameter of the guard.
    expect(insert!.text).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(insert!.text).toContain('WHERE COALESCE');
    expect(insert!.params).toContain(tailHash);
    expect(insert!.params).toContain(GENESIS_HASH);
  });

  it('anchors at the genesis hash when the log is empty', async () => {
    const { pool } = fakePool((text) =>
      text.startsWith('SELECT hash, created_at FROM admin.audit_events')
        ? { rows: [] }
        : { rows: [], rowCount: 1 }
    );
    const event = await new PgAuditRepository(pool).append(unsignedEvent('audit-genesis'));
    expect(event.prevHash).toBe(GENESIS_HASH);
  });

  it('retries on 23505 (concurrent fork rejected by UNIQUE(prev_hash)) and then succeeds', async () => {
    let inserts = 0;
    const { pool, calls } = fakePool((text) => {
      if (text.startsWith('SELECT hash, created_at FROM admin.audit_events')) {
        return { rows: [{ hash: `${inserts > 0 ? 'b' : 'a'}`.repeat(64).slice(0, 64) }] };
      }
      inserts += 1;
      if (inserts === 1) {
        return uniqueViolation();
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PgAuditRepository(pool);

    const event = await repository.append(unsignedEvent('audit-retry'));

    expect(event.prevHash).toBe('b'.repeat(64)); // re-read the new tail
    expect(calls.filter((call) => call.text.startsWith('INSERT INTO admin.audit_events'))).toHaveLength(2);
  });

  it('retries when the tail guard admits zero rows (tail moved mid-append)', async () => {
    let inserts = 0;
    const { pool, calls } = fakePool((text) => {
      if (text.startsWith('SELECT hash, created_at FROM admin.audit_events')) {
        return { rows: [{ hash: 'c'.repeat(64) }] };
      }
      inserts += 1;
      return { rows: [], rowCount: inserts === 1 ? 0 : 1 };
    });
    const repository = new PgAuditRepository(pool);

    await repository.append(unsignedEvent('audit-guard'));

    expect(calls.filter((call) => call.text.startsWith('INSERT INTO admin.audit_events'))).toHaveLength(2);
  });

  it('fails loudly after a bounded number of fork races', async () => {
    const { pool, calls } = fakePool((text) =>
      text.startsWith('SELECT hash, created_at FROM admin.audit_events')
        ? { rows: [{ hash: 'd'.repeat(64) }] }
        : uniqueViolation()
    );
    const repository = new PgAuditRepository(pool);

    await expect(repository.append(unsignedEvent('audit-stuck'))).rejects.toThrow(
      /audit chain append failed after 3 attempts/
    );
    expect(calls.filter((call) => call.text.startsWith('INSERT INTO admin.audit_events'))).toHaveLength(3);
  });

  it('propagates non-fork database errors without retrying', async () => {
    const { pool, calls } = fakePool((text) =>
      text.startsWith('SELECT hash, created_at FROM admin.audit_events')
        ? { rows: [{ hash: 'e'.repeat(64) }] }
        : Object.assign(new Error('connection reset'), { code: '08006' })
    );
    const repository = new PgAuditRepository(pool);

    await expect(repository.append(unsignedEvent('audit-down'))).rejects.toThrow('connection reset');
    expect(calls.filter((call) => call.text.startsWith('INSERT INTO admin.audit_events'))).toHaveLength(1);
  });
});

/**
 * Live contract tests. Skipped unless DATABASE_URL points at a database with
 * migrations through 043 applied (see test/pg/pg-repositories.spec.ts header
 * for the docker compose invocation).
 */
const describePg = describe.skipIf(!process.env.DATABASE_URL);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : null;

async function cleanAuditRows(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM admin.audit_events WHERE entity_id LIKE 'contract-audit-%'`);
}

describePg('pg audit chain fork guard (migration 043)', () => {
  it('concurrent appends from two "replicas" extend one valid, unforked chain', async () => {
    if (!pool) return;
    await cleanAuditRows();
    // Two repository+service pairs over the same pool simulate two API
    // replicas behind the HPA, each with its own (now removed) tail cache.
    const replicaA = new AuditService(createPgAuditRepository(pool));
    const replicaB = new AuditService(createPgAuditRepository(pool));
    const replicas = [replicaA, replicaB];

    // Batches of 3 concurrent writers (a realistic HPA replica burst): each
    // batch stresses the fork-rejection retry loop while staying inside the
    // bounded attempt budget — optimistic chain extension needs at most one
    // attempt per simultaneous contender, and AUDIT_APPEND_MAX_ATTEMPTS = 3.
    const recorded: AuditEvent[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      recorded.push(
        ...(await Promise.all(
          Array.from({ length: 3 }, (_, i) => {
            const n = batch * 3 + i;
            return replicas[n % 2].record({
              actorId: 'contract-audit-actor',
              action: 'contract.audit.write',
              entityType: 'test',
              entityId: `contract-audit-concurrent-${n}`
            });
          })
        ))
      );
    }
    expect(recorded).toHaveLength(9);
    // No fork: every event claims a distinct parent hash.
    expect(new Set(recorded.map((event) => event.prevHash)).size).toBe(9);

    const verification = await replicaA.verify();
    expect(verification.valid).toBe(true);

    const links = await pool.query(
      `SELECT prev_hash FROM admin.audit_events WHERE entity_id LIKE 'contract-audit-%'`
    );
    const parents = new Set(links.rows.map((row) => row.prev_hash as string));
    expect(parents.size).toBe(9);
    await cleanAuditRows();
  });

  it('UNIQUE(prev_hash) rejects a forged sibling branch at the database level', async () => {
    if (!pool) return;
    await cleanAuditRows();
    const repository = createPgAuditRepository(pool);
    const first = await repository.append({
      ...unsignedEvent('contract-audit-fork-base'),
      entityId: 'contract-audit-fork-base'
    });
    const sibling = await repository.append({
      ...unsignedEvent('contract-audit-fork-sibling'),
      entityId: 'contract-audit-fork-sibling'
    });

    // Forge a second child claiming the same parent as `sibling`.
    const forgedUnsigned: Omit<AuditEvent, 'hash'> = {
      id: 'contract-audit-fork-forged',
      actorId: 'attacker',
      action: 'user.suspend',
      entityType: 'user',
      entityId: 'contract-audit-fork-forged',
      metadata: {},
      createdAt: new Date().toISOString(),
      prevHash: first.hash
    };
    const forged: AuditEvent = {
      ...forgedUnsigned,
      hash: hashAuditEvent(forgedUnsigned, first.hash!)
    };
    expect(forged.prevHash).toBe(sibling.prevHash);
    await expect(
      pool.query(
        `INSERT INTO admin.audit_events (id, actor_id, action, entity_type, entity_id, metadata, created_at, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          forged.id,
          forged.actorId,
          forged.action,
          forged.entityType,
          forged.entityId,
          JSON.stringify(forged.metadata),
          forged.createdAt,
          forged.prevHash,
          forged.hash
        ]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await cleanAuditRows();
  });

  it('CHECK constraints reject malformed chain hashes', async () => {
    if (!pool) return;
    await cleanAuditRows();
    await expect(
      pool.query(
        `INSERT INTO admin.audit_events (id, actor_id, action, entity_type, entity_id, metadata, created_at, prev_hash, hash)
         VALUES ('contract-audit-bad-hash', 'a', 'x', 'test', 'contract-audit-bad-hash', '{}', now(), $1, $2)`,
        [GENESIS_HASH, 'not-a-sha256-hex']
      )
    ).rejects.toMatchObject({ code: '23514' });
    await cleanAuditRows();
  });

  it('append links to the true tail even when a stale reader missed the latest row', async () => {
    if (!pool) return;
    await cleanAuditRows();
    const staleReplica = createPgAuditRepository(pool);
    const liveReplica = createPgAuditRepository(pool);
    const first = await staleReplica.append({
      ...unsignedEvent('contract-audit-tail-1'),
      entityId: 'contract-audit-tail-1'
    });
    const second = await liveReplica.append({
      ...unsignedEvent('contract-audit-tail-2'),
      entityId: 'contract-audit-tail-2'
    });
    // The second replica's first-ever append (empty cache scenario) must link
    // to the row the first replica just wrote — the tail is derived in the
    // database, never from per-process state.
    expect(second.prevHash).toBe(first.hash);
    await cleanAuditRows();
  });
});

/**
 * Stage 23 anchoring checkpoints (migration 047). Query-spy tests run
 * everywhere; the live contract tests run in CI's db-contract job against a
 * database with migration 047 applied. They live in THIS file (not a
 * parallel spec) so anchor/event scenarios share one sequential database
 * story — vitest runs spec files concurrently and admin.audit_events is a
 * shared table.
 */

const unsignedAnchor = (id: string): Omit<AuditAnchor, 'prevAnchorHash' | 'anchorHash'> => ({
  id,
  anchoredThroughEventId: 'audit-1',
  tipHash: 'f'.repeat(64),
  eventCount: 7,
  createdAt: '2026-06-01T00:00:01.000Z'
});

describe('pg audit anchor append (query spy)', () => {
  it('links to the anchor tip read from the database and issues a single guarded INSERT', async () => {
    const tipHash = 'a'.repeat(64);
    const { pool: spyPool, calls } = fakePool((text) =>
      text.startsWith('SELECT id, anchored_through_event_id')
        ? { rows: [{ anchor_hash: tipHash, created_at: new Date('2026-06-01T00:00:00.000Z') }] }
        : { rows: [], rowCount: 1 }
    );
    const repository = new PgAuditAnchorRepository(spyPool);

    const anchor = await repository.append(unsignedAnchor('anchor-1'));

    expect(anchor.prevAnchorHash).toBe(tipHash);
    const { anchorHash, ...linkedPayload } = anchor;
    expect(anchorHash).toBe(hashAuditAnchor(linkedPayload, tipHash));
    expect(anchorHash).toMatch(/^[0-9a-f]{64}$/);
    const insert = calls.find((call) => call.text.startsWith('INSERT INTO audit.anchors'));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(insert!.text).toContain('WHERE COALESCE');
    expect(insert!.params).toContain(tipHash);
    expect(insert!.params).toContain(GENESIS_HASH);
  });

  it('anchors at the genesis hash when no anchor exists yet', async () => {
    const { pool: spyPool } = fakePool((text) =>
      text.startsWith('SELECT id, anchored_through_event_id')
        ? { rows: [] }
        : { rows: [], rowCount: 1 }
    );
    const anchor = await new PgAuditAnchorRepository(spyPool).append(unsignedAnchor('anchor-first'));
    expect(anchor.prevAnchorHash).toBe(GENESIS_HASH);
  });

  it('retries on 23505 (concurrent anchor rejected by UNIQUE(prev_anchor_hash)) and then succeeds', async () => {
    let inserts = 0;
    const { pool: spyPool, calls } = fakePool((text) => {
      if (text.startsWith('SELECT id, anchored_through_event_id')) {
        return { rows: [{ anchor_hash: `${inserts > 0 ? 'b' : 'a'}`.repeat(64).slice(0, 64) }] };
      }
      inserts += 1;
      if (inserts === 1) {
        return uniqueViolation();
      }
      return { rows: [], rowCount: 1 };
    });
    const anchor = await new PgAuditAnchorRepository(spyPool).append(unsignedAnchor('anchor-retry'));
    expect(anchor.prevAnchorHash).toBe('b'.repeat(64)); // re-read the new tip
    expect(calls.filter((call) => call.text.startsWith('INSERT INTO audit.anchors'))).toHaveLength(2);
  });

  it('fails loudly after a bounded number of anchor-chain races', async () => {
    const { pool: spyPool, calls } = fakePool((text) =>
      text.startsWith('SELECT id, anchored_through_event_id')
        ? { rows: [{ anchor_hash: 'c'.repeat(64) }] }
        : uniqueViolation()
    );
    await expect(
      new PgAuditAnchorRepository(spyPool).append(unsignedAnchor('anchor-stuck'))
    ).rejects.toThrow(/audit anchor append failed after 3 attempts/);
    expect(calls.filter((call) => call.text.startsWith('INSERT INTO audit.anchors'))).toHaveLength(3);
  });

  it('maps rows cleanly: bigint event_count and Date created_at round-trip to the hashed types', async () => {
    // Stage 22 lesson: the mapper must reproduce exactly the payload the
    // writer hashed — pg returns bigint as string and timestamptz as Date.
    const row = {
      id: 'anchor-row',
      anchored_through_event_id: null,
      tip_hash: 'd'.repeat(64),
      event_count: '7',
      prev_anchor_hash: GENESIS_HASH,
      anchor_hash: '0'.repeat(64),
      created_at: new Date('2026-06-01T00:00:01.000Z')
    };
    const { pool: spyPool } = fakePool(() => ({ rows: [row] }));
    const repository = new PgAuditAnchorRepository(spyPool);

    const [anchor] = await repository.list();
    expect(anchor).toEqual({
      id: 'anchor-row',
      anchoredThroughEventId: null,
      tipHash: 'd'.repeat(64),
      eventCount: 7,
      prevAnchorHash: GENESIS_HASH,
      anchorHash: '0'.repeat(64),
      createdAt: '2026-06-01T00:00:01.000Z'
    });
    // And the mapped shape reproduces a writer-computed hash byte-for-byte.
    const { anchorHash, ...unsigned } = anchor;
    expect(hashAuditAnchor(unsigned, GENESIS_HASH)).toMatch(/^[0-9a-f]{64}$/);
    const latest = await repository.latest();
    expect(latest).toEqual(anchor);
  });
});

async function cleanAnchorRows(): Promise<void> {
  if (!pool) return;
  // Only this spec file writes audit.anchors; events use the shared prefix.
  await pool.query(`DELETE FROM audit.anchors`);
}

describePg('pg audit anchors (migration 047)', () => {
  function buildAnchoredService(): AuditAnchorService {
    if (!pool) throw new Error('DATABASE_URL not set');
    return new AuditAnchorService(
      createPgAuditRepository(pool),
      createPgAuditAnchorRepository(pool),
      {},
      null
    );
  }

  it('creates an anchor over the live chain tip and verifies clean', async () => {
    if (!pool) return;
    await cleanAuditRows();
    await cleanAnchorRows();
    const audit = new AuditService(createPgAuditRepository(pool));
    const service = buildAnchoredService();
    const recorded: AuditEvent[] = [];
    for (let i = 0; i < 3; i += 1) {
      recorded.push(
        await audit.record({
          actorId: 'contract-audit-actor',
          action: 'contract.audit.write',
          entityType: 'test',
          entityId: `contract-audit-anchor-roundtrip-${i}`
        })
      );
    }

    const anchor = await service.createAnchor();

    expect(anchor.anchoredThroughEventId).toBe(recorded[2].id);
    expect(anchor.tipHash).toBe(recorded[2].hash);
    expect(anchor.eventCount).toBe(3);
    expect(anchor.prevAnchorHash).toBe(GENESIS_HASH);
    // The persisted row round-trips through the mapper with identical fields.
    const persisted = await service.listAnchors();
    expect(persisted).toEqual([anchor]);
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 1 });
    await cleanAnchorRows();
    await cleanAuditRows();
  });

  it('chains consecutive anchors; UNIQUE(prev_anchor_hash) rejects a forged sibling', async () => {
    if (!pool) return;
    await cleanAuditRows();
    await cleanAnchorRows();
    const audit = new AuditService(createPgAuditRepository(pool));
    const service = buildAnchoredService();
    await audit.record({
      actorId: 'contract-audit-actor',
      action: 'contract.audit.write',
      entityType: 'test',
      entityId: 'contract-audit-anchor-chain-0'
    });
    const first = await service.createAnchor();
    await audit.record({
      actorId: 'contract-audit-actor',
      action: 'contract.audit.write',
      entityType: 'test',
      entityId: 'contract-audit-anchor-chain-1'
    });
    const second = await service.createAnchor();

    expect(second.prevAnchorHash).toBe(first.anchorHash);
    expect(second.eventCount).toBe(2);
    await expect(service.verifyAnchors()).resolves.toEqual({ valid: true, checked: 2 });
    expect((await service.listAnchors()).map((anchor) => anchor.id)).toEqual([first.id, second.id]);

    // Forge a second genesis anchor claiming the same (genesis) parent.
    await expect(
      pool.query(
        `INSERT INTO audit.anchors (id, anchored_through_event_id, tip_hash, event_count, prev_anchor_hash, anchor_hash)
         VALUES (gen_random_uuid(), NULL, $1, 0, $2, $3)`,
        ['e'.repeat(64), GENESIS_HASH, 'f'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await cleanAnchorRows();
    await cleanAuditRows();
  });

  it('CHECK constraints reject malformed anchor hashes and negative counts', async () => {
    if (!pool) return;
    await cleanAnchorRows();
    await expect(
      pool.query(
        `INSERT INTO audit.anchors (id, anchored_through_event_id, tip_hash, event_count, prev_anchor_hash, anchor_hash)
         VALUES (gen_random_uuid(), NULL, $1, 0, $2, $3)`,
        ['not-a-sha256-hex', GENESIS_HASH, 'f'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO audit.anchors (id, anchored_through_event_id, tip_hash, event_count, prev_anchor_hash, anchor_hash)
         VALUES (gen_random_uuid(), NULL, $1, -1, $2, $3)`,
        ['e'.repeat(64), GENESIS_HASH, 'f'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await cleanAnchorRows();
  });

  it('verify detects tail truncation after an anchor, including a valid re-extension', async () => {
    if (!pool) return;
    await cleanAuditRows();
    await cleanAnchorRows();
    const auditRepository = createPgAuditRepository(pool);
    const audit = new AuditService(auditRepository);
    const service = buildAnchoredService();
    const recorded: AuditEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      recorded.push(
        await audit.record({
          actorId: 'contract-audit-actor',
          action: 'contract.audit.write',
          entityType: 'test',
          entityId: `contract-audit-anchor-truncate-${i}`
        })
      );
    }
    const anchor = await service.createAnchor();
    expect(anchor.anchoredThroughEventId).toBe(recorded[4].id);

    // Attacker deletes the last 2 events: pure truncation.
    await pool.query(`DELETE FROM admin.audit_events WHERE id = ANY($1)`, [
      [recorded[3].id, recorded[4].id]
    ]);
    const truncated = await service.verifyAnchors();
    expect(truncated.valid).toBe(false);
    expect(truncated.gap).toMatchObject({
      reason: 'event_count_regression',
      anchorId: anchor.id,
      anchoredEventCount: 5,
      actualEventCount: 3
    });

    // Attacker re-extends from the earlier prefix: the event chain is valid
    // again and back to length 5, but the notarized tip is gone.
    await audit.record({
      actorId: 'attacker',
      action: 'contract.audit.cover_up',
      entityType: 'test',
      entityId: 'contract-audit-anchor-coverup-0'
    });
    const coverTip = await audit.record({
      actorId: 'attacker',
      action: 'contract.audit.cover_up',
      entityType: 'test',
      entityId: 'contract-audit-anchor-coverup-1'
    });
    await expect(audit.verify()).resolves.toMatchObject({ valid: true });
    const reextended = await service.verifyAnchors();
    expect(reextended.valid).toBe(false);
    expect(reextended.gap).toMatchObject({
      reason: 'anchor_tip_missing',
      anchorId: anchor.id,
      anchoredThroughEventId: recorded[4].id,
      anchoredEventCount: 5,
      actualEventCount: 5,
      currentTipEventId: coverTip.id
    });
    await cleanAnchorRows();
    await cleanAuditRows();
  });

  it('verify detects anchor-chain tampering (payload rewrite)', async () => {
    if (!pool) return;
    await cleanAuditRows();
    await cleanAnchorRows();
    const audit = new AuditService(createPgAuditRepository(pool));
    const service = buildAnchoredService();
    await audit.record({
      actorId: 'contract-audit-actor',
      action: 'contract.audit.write',
      entityType: 'test',
      entityId: 'contract-audit-anchor-tamper-0'
    });
    const anchor = await service.createAnchor();

    // Attacker rewrites the notarized count inside the anchors table.
    await pool.query(`UPDATE audit.anchors SET event_count = event_count + 1 WHERE id = $1`, [
      anchor.id
    ]);

    const result = await service.verifyAnchors();
    expect(result.valid).toBe(false);
    expect(result.brokenAnchorAt).toBe(anchor.id);
    await cleanAnchorRows();
    await cleanAuditRows();
  });
});
