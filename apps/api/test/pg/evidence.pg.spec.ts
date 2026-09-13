import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { EvidenceItem } from '@agric-platform/shared';
import {
  createPgEvidenceItemRepository,
  PgEvidenceItemRepository
} from '../../src/database/repositories/evidence-item.pg-repository.js';
import {
  EVIDENCE_GENESIS_HASH,
  linkEvidenceItem,
  verifyEvidenceChain
} from '../../src/modules/evidence/evidence-hash.js';
import { SqlCaseParticipantLookup } from '../../src/modules/evidence/case-participants.js';

/**
 * Evidence Locker pg contract tests (Stage 27 Innovation 13, migration 071).
 *
 * Two layers (same split as audit-chain.pg.spec.ts):
 *  - `pg evidence append (query spy)`: always-on unit tests over a fake
 *    pool proving the atomic guarded INSERT shape, the 23505/tail-moved
 *    retry loop, the object-key conflict mapping, and the guarded CAS
 *    status transitions.
 *  - `pg evidence.items contract`: live contract tests in the standard
 *    describe.skipIf(!DATABASE_URL) style, exercised by CI's db-contract
 *    job: append-only chain extension, fork rejection, UNIQUE object_key,
 *    CAS-only mutation, and chain verification over persisted rows.
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

const uniqueViolation = (): Error & { code: string } =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });

const unsignedItem = (
  id: string,
  objectKey: string
): Omit<EvidenceItem, 'prevHash' | 'itemHash'> => ({
  id,
  caseType: 'escrow',
  caseId: 'escrow-1',
  uploaderId: 'user-buyer',
  objectKey,
  sha256: 'a'.repeat(64),
  capturedAt: null,
  uploadedAt: '2026-09-01T10:00:00.000Z',
  mime: 'image/jpeg',
  sizeBytes: 1024,
  status: 'active'
});

describe('pg evidence append (query spy)', () => {
  // NOTE on the fakes: the guarded INSERT embeds the tip subquery, so
  // routing must key on the STATEMENT start, never on includes() fragments.
  const isTipQuery = (text: string): boolean => text.startsWith('SELECT') && text.includes('DESC');
  const isObjectKeyLookup = (text: string): boolean =>
    text.startsWith('SELECT') && text.includes('WHERE object_key');

  it('links to the case tip and issues a single guarded INSERT', async () => {
    const tipHash = 'f'.repeat(64);
    const { pool, calls } = fakePool((text) =>
      isTipQuery(text)
        ? { rows: [{ item_hash: tipHash, uploaded_at: '2026-09-01T09:00:00.000Z' }] }
        : { rows: [], rowCount: 1 }
    );
    const repository = new PgEvidenceItemRepository(pool);
    const item = await repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'));
    expect(item.prevHash).toBe(tipHash);
    const insert = calls.find((call) => call.text.includes('INSERT INTO evidence.items'));
    expect(insert).toBeDefined();
    // Guarded: the INSERT re-reads the case tip inside the statement.
    expect(insert?.text).toContain('WHERE COALESCE((SELECT item_hash FROM evidence.items');
    // $n+1 = claimed parent, $n+2 = genesis, then case identity.
    const tail = insert?.params.slice(-4);
    expect(tail).toEqual([tipHash, EVIDENCE_GENESIS_HASH, 'escrow', 'escrow-1']);
  });

  it('uses genesis when the case has no tip', async () => {
    const { pool } = fakePool((text) =>
      isTipQuery(text) ? { rows: [] } : { rows: [], rowCount: 1 }
    );
    const repository = new PgEvidenceItemRepository(pool);
    const item = await repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'));
    expect(item.prevHash).toBe(EVIDENCE_GENESIS_HASH);
  });

  it('retries against the new tip when the guard reports a moved tail', async () => {
    let inserts = 0;
    const freshTip = 'e'.repeat(64);
    const { pool, calls } = fakePool((text) => {
      if (isTipQuery(text)) {
        return {
          rows: [{ item_hash: freshTip, uploaded_at: '2026-09-01T09:00:00.000Z' }]
        };
      }
      inserts += 1;
      // First INSERT sees a stale tip (0 rows); second succeeds.
      return inserts === 1 ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
    });
    const repository = new PgEvidenceItemRepository(pool);
    const item = await repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'));
    expect(item.prevHash).toBe(freshTip);
    expect(calls.filter((call) => call.text.includes('INSERT')).length).toBe(2);
  });

  it('retries on a chain-link unique violation (concurrent fork attempt)', async () => {
    let inserts = 0;
    const { pool } = fakePool((text) => {
      if (isTipQuery(text)) {
        return { rows: [] };
      }
      if (isObjectKeyLookup(text)) {
        return { rows: [] }; // not an object-key conflict
      }
      inserts += 1;
      return inserts === 1 ? uniqueViolation() : { rows: [], rowCount: 1 };
    });
    const repository = new PgEvidenceItemRepository(pool);
    await expect(
      repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'))
    ).resolves.toMatchObject({ id: 'evi-1' });
    expect(inserts).toBe(2);
  });

  it('maps an object-key unique violation to ConflictException without retrying', async () => {
    const existing = unsignedItem('evi-0', 'evidence/escrow/escrow-1/evi-1');
    const linked = linkEvidenceItem(existing, EVIDENCE_GENESIS_HASH);
    const { pool, calls } = fakePool((text) => {
      if (isTipQuery(text)) {
        return { rows: [] };
      }
      if (isObjectKeyLookup(text)) {
        return {
          rows: [
            {
              id: linked.id,
              case_type: linked.caseType,
              case_id: linked.caseId,
              uploader_id: linked.uploaderId,
              object_key: linked.objectKey,
              sha256: linked.sha256,
              prev_hash: linked.prevHash,
              item_hash: linked.itemHash,
              captured_at: null,
              uploaded_at: linked.uploadedAt,
              mime: linked.mime,
              size_bytes: String(linked.sizeBytes),
              status: linked.status
            }
          ]
        };
      }
      return uniqueViolation();
    });
    const repository = new PgEvidenceItemRepository(pool);
    await expect(
      repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'))
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.filter((call) => call.text.includes('INSERT')).length).toBe(1);
  });

  it('fails loudly after bounded attempts under sustained contention', async () => {
    const { pool } = fakePool((text) => {
      if (isTipQuery(text)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 }; // tip keeps moving
    });
    const repository = new PgEvidenceItemRepository(pool);
    await expect(
      repository.append(unsignedItem('evi-1', 'evidence/escrow/escrow-1/evi-1'))
    ).rejects.toThrow(/after 3 attempts/);
  });

  it('transitionStatus issues a guarded CAS UPDATE (append-only exception)', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 0 }));
    const repository = new PgEvidenceItemRepository(pool);
    const result = await repository.transitionStatus('evi-1', ['active', 'sealed'], 'expunged');
    expect(result).toBeUndefined(); // CAS lost -> caller answers 409
    const update = calls.find((call) => call.text.startsWith('UPDATE evidence.items'));
    expect(update?.text).toContain('WHERE id = $1 AND status = ANY($3)');
    expect(update?.params).toEqual(['evi-1', 'expunged', ['active', 'sealed']]);
  });

  it('sealCase CAS-transitions only active items of the case', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 2 }));
    const repository = new PgEvidenceItemRepository(pool);
    await expect(repository.sealCase('escrow', 'escrow-1')).resolves.toBe(2);
    const update = calls.find((call) => call.text.startsWith('UPDATE evidence.items'));
    expect(update?.text).toContain("SET status = 'sealed'");
    expect(update?.text).toContain("status = 'active'");
    expect(update?.params).toEqual(['escrow', 'escrow-1']);
  });
});

describe('case participant lookup (query spy)', () => {
  it('pool cases fail closed (empty party set) without touching the database', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [] }));
    const lookup = new SqlCaseParticipantLookup(pool);
    await expect(lookup.participants('pool', 'pool-1')).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('escrow lookup reads buyer and seller read-only via the order join', async () => {
    const { pool, calls } = fakePool(() => ({
      rows: [{ party: 'user-buyer' }, { party: 'user-seller' }]
    }));
    const lookup = new SqlCaseParticipantLookup(pool);
    await expect(lookup.participants('escrow', 'escrow-1')).resolves.toEqual([
      'user-buyer',
      'user-seller'
    ]);
    expect(calls[0].text).toContain('marketplace.escrow_records');
    expect(calls[0].text).toContain('marketplace.orders');
    expect(calls[0].text.toUpperCase()).not.toContain('INSERT');
    expect(calls[0].text.toUpperCase()).not.toContain('UPDATE');
    expect(calls[0].params).toEqual(['escrow-1']);
  });

  it('vsla/insurance lookups stay read-only against their registries', async () => {
    const { pool, calls } = fakePool(() => ({ rows: [{ party: 'user-1' }] }));
    const lookup = new SqlCaseParticipantLookup(pool);
    await lookup.participants('vsla', 'grp-1');
    await lookup.participants('insurance', 'pol-1');
    expect(calls[0].text).toContain('vsla_carbon.vsla_members');
    expect(calls[1].text).toContain('insurance.policies');
  });
});

// ---------------------------------------------------------------------------
// Live contract tests (CI db-contract job; skipped without DATABASE_URL)
// ---------------------------------------------------------------------------

const describePg = describe.skipIf(!process.env.DATABASE_URL);
const livePool = process.env.DATABASE_URL
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
  '071_evidence_locker.sql'
);

const CASE_ID = 'pgtest-evidence-case';

// Live items must carry the live CASE_ID: unsignedItem() defaults to the
// query-spy case 'escrow-1', while listCaseItems()/clean() key on CASE_ID.
const liveItem = (
  id: string,
  objectKey: string
): Omit<EvidenceItem, 'prevHash' | 'itemHash'> => ({
  ...unsignedItem(id, objectKey),
  caseId: CASE_ID
});

async function clean(): Promise<void> {
  await livePool!.query('DELETE FROM evidence.items WHERE case_id = $1', [CASE_ID]);
}

describePg('pg evidence.items contract (migration 071)', () => {
  beforeAll(async () => {
    await livePool!.query(readFileSync(MIGRATION, 'utf8'));
    await livePool!.query(readFileSync(MIGRATION, 'utf8')); // idempotent re-apply must not throw
    await clean();
  });

  afterAll(async () => {
    await clean();
    await livePool!.end();
  });

  it('appends a hash chain, enforces UNIQUE object_key, and verifies end-to-end', async () => {
    const repository = createPgEvidenceItemRepository(livePool!);
    const first = await repository.append(liveItem('pgtest-evi-1', `evidence/escrow/${CASE_ID}/evi-1`));
    expect(first.prevHash).toBe(EVIDENCE_GENESIS_HASH);
    const second = await repository.append({
      ...liveItem('pgtest-evi-2', `evidence/escrow/${CASE_ID}/evi-2`),
      uploadedAt: '2026-09-01T10:01:00.000Z'
    });
    expect(second.prevHash).toBe(first.itemHash);

    // UNIQUE object_key: same object, different id -> ConflictException.
    await expect(
      repository.append(liveItem('pgtest-evi-3', `evidence/escrow/${CASE_ID}/evi-1`))
    ).rejects.toBeInstanceOf(ConflictException);

    const items = await repository.listCaseItems('escrow', CASE_ID);
    expect(items.map((item) => item.id)).toEqual(['pgtest-evi-1', 'pgtest-evi-2']);
    expect(verifyEvidenceChain(items)).toMatchObject({ valid: true, checked: 2 });
  });

  it('rejects a forged append claiming the wrong parent (guarded INSERT)', async () => {
    // Two concurrent appends race for the same tip: the loser's guarded
    // INSERT either retries or fails loudly — it can NEVER fork the chain.
    const repository = createPgEvidenceItemRepository(livePool!);
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((suffix) =>
        repository.append(
          liveItem(`pgtest-evi-race-${suffix}`, `evidence/escrow/${CASE_ID}/evi-race-${suffix}`)
        )
      )
    );
    const appended = results.filter((r) => r.status === 'fulfilled').length;
    expect(appended).toBeGreaterThan(0);
    const items = await repository.listCaseItems('escrow', CASE_ID);
    // Whatever the interleaving, the persisted chain must verify.
    expect(verifyEvidenceChain(items).valid).toBe(true);
  });

  it('CAS transitions are the ONLY mutation: seal and expunge keep the chain valid', async () => {
    const repository = createPgEvidenceItemRepository(livePool!);
    const before = await repository.listCaseItems('escrow', CASE_ID);
    const moved = await repository.sealCase('escrow', CASE_ID);
    expect(moved).toBeGreaterThan(0);
    const sealed = await repository.listCaseItems('escrow', CASE_ID);
    expect(sealed.every((item) => item.status === 'sealed')).toBe(true);
    // Hash fields untouched by the transition.
    expect(sealed.map((item) => item.itemHash)).toEqual(before.map((item) => item.itemHash));
    expect(verifyEvidenceChain(sealed).valid).toBe(true);
    // Re-seal is a no-op (CAS guard).
    await expect(repository.sealCase('escrow', CASE_ID)).resolves.toBe(0);
    // Expunge tombstone: sealed -> expunged, hashes retained.
    const tombstone = await repository.transitionStatus(
      'pgtest-evi-1',
      ['active', 'sealed'],
      'expunged'
    );
    expect(tombstone?.status).toBe('expunged');
    expect(tombstone?.itemHash).toBe(before[0].itemHash);
    // Terminal: no further transition is admitted.
    await expect(
      repository.transitionStatus('pgtest-evi-1', ['active', 'sealed'], 'expunged')
    ).resolves.toBeUndefined();
    const after = await repository.listCaseItems('escrow', CASE_ID);
    expect(verifyEvidenceChain(after).valid).toBe(true);
  });

  it('database rejects provenance rewrites on constrained columns', async () => {
    // sha256 is char(64) hex-checked; an out-of-band rewrite that violates
    // the format CHECK fails outright, and any other rewrite breaks the
    // chain hash (verified above).
    await expect(
      livePool!.query(
        'UPDATE evidence.items SET sha256 = $1 WHERE id = $2',
        ['not-hex', 'pgtest-evi-2']
      )
    ).rejects.toThrow();
    // size_bytes must stay positive.
    await expect(
      livePool!.query('UPDATE evidence.items SET size_bytes = 0 WHERE id = $1', ['pgtest-evi-2'])
    ).rejects.toThrow();
  });
});
