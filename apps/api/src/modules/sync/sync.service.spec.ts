import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import {
  InMemoryEntityVersionRepository,
  InMemorySyncCursorRepository,
  InMemorySyncMutationRepository,
  type EntityVersionRepository
} from '../../database/repositories/sync.repository.js';
import { SyncEntityRegistry, type SyncableEntityDescriptor } from './sync-registry.js';
import { SyncVersionConflictError } from './sync.types.js';
import { SyncService } from './sync.service.js';
import type { SyncPushItem } from './sync.types.js';

/**
 * In-memory parity suite for the sync engine (Wave SYNCSRV). The writable
 * `test_note` entity stands in for future client-writable entities (farms
 * wave); the read-only `ro_listing` entity mirrors the v1 proof entities.
 */

interface NoteRecord {
  ownerId: string;
  text: string;
}

function makeHarness() {
  const versions = new InMemoryEntityVersionRepository();
  const cursors = new InMemorySyncCursorRepository();
  const mutations = new InMemorySyncMutationRepository();
  const registry = new SyncEntityRegistry();
  const notes = new Map<string, NoteRecord>();

  const noteDescriptor: SyncableEntityDescriptor = {
    name: 'test_note',
    ownerField: 'ownerId',
    writable: true,
    getOwnerId: async (id) => notes.get(id)?.ownerId ?? null,
    getPayloads: async (ids) => {
      const out = new Map<string, unknown>();
      for (const id of ids) {
        const record = notes.get(id);
        if (record) out.set(id, { ...record });
      }
      return out;
    },
    apply: async (actor, item) => {
      // v2 apply discipline: claim the version row atomically AROUND the
      // entity write (V-18) — mirrors FarmsService.applySyncedPlot.
      if (item.op === 'delete') {
        const claimed = await versions.applyGuarded(
          {
            entity: 'test_note',
            entityId: item.entityId,
            ownerId: notes.get(item.entityId)?.ownerId ?? actor.id,
            updatedBy: actor.id,
            deleted: true,
            expectedVersion: item.baseVersion
          },
          async () => {
            notes.delete(item.entityId);
          }
        );
        if (claimed === null) throw new SyncVersionConflictError('test_note', item.entityId);
        return claimed.version;
      }
      const claimed = await versions.applyGuarded(
        {
          entity: 'test_note',
          entityId: item.entityId,
          ownerId: notes.get(item.entityId)?.ownerId ?? actor.id,
          updatedBy: actor.id,
          expectedVersion: item.baseVersion
        },
        async () => {
          notes.set(item.entityId, {
            ownerId: notes.get(item.entityId)?.ownerId ?? actor.id,
            text: String(item.payload?.text ?? '')
          });
        }
      );
      if (claimed === null) throw new SyncVersionConflictError('test_note', item.entityId);
      return claimed.version;
    }
  };
  registry.register(noteDescriptor);

  registry.register({
    name: 'ro_listing',
    ownerField: 'sellerId',
    writable: false,
    getOwnerId: async () => 'user-1',
    getPayloads: async () => new Map([['l-1', { title: 'Maize' }]])
  });

  const published: string[] = [];
  const audited: string[] = [];
  const events = {
    publish: async (name: string) => {
      published.push(name);
      return {};
    }
  } as unknown as DomainEventsService;
  const audit = {
    record: async (input: { action: string }) => {
      audited.push(input.action);
      return {};
    }
  } as unknown as AuditService;

  const service = new SyncService(registry, versions, cursors, mutations, events, audit);
  return { service, versions, cursors, mutations, registry, notes, published, audited };
}

const owner = { id: 'user-1', roles: ['farmer'] } as User;
const outsider = { id: 'user-2', roles: ['farmer'] } as User;
const admin = { id: 'admin-1', roles: ['admin'] } as User;

function item(partial: Partial<SyncPushItem> & Pick<SyncPushItem, 'entityId' | 'clientMutationId'>): SyncPushItem {
  return {
    entity: 'test_note',
    baseVersion: 0,
    op: 'upsert',
    payload: { text: 'hello' },
    ...partial
  };
}

describe('SyncService.push', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('applies a create at baseVersion 0 and returns newVersion 1', async () => {
    const [result] = await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 1 });
    expect(h.notes.get('n-1')).toEqual({ ownerId: owner.id, text: 'hello' });
  });

  it('applies an update at the matching baseVersion and increments', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [result] = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 1, payload: { text: 'v2' } })
    ]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 2 });
    expect(h.notes.get('n-1')!.text).toBe('v2');
  });

  it('conflicts on a stale baseVersion and never overwrites silently', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [result] = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0, payload: { text: 'stale' } })
    ]);
    expect(result.status).toBe('conflict');
    expect(result.serverVersion).toBe(1);
    expect(result.serverPayload).toMatchObject({ text: 'hello' });
    expect(h.notes.get('n-1')!.text).toBe('hello');
  });

  it('conflicts on an update to a nonexistent record with baseVersion > 0', async () => {
    const [result] = await h.service.push(owner, [
      item({ entityId: 'ghost', clientMutationId: 'm-1', baseVersion: 3 })
    ]);
    expect(result).toMatchObject({ status: 'conflict', serverVersion: 0 });
  });

  it('replays the ORIGINAL outcome for a retried clientMutationId without re-applying', async () => {
    const first = await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const replay = await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    expect(replay[0]).toEqual(first[0]);
    expect((await h.versions.current('test_note', 'n-1'))!.version).toBe(1);
  });

  it('recomputes conflicts on retry instead of replaying a stale ledgered payload (V-65)', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const conflict = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })
    ]);
    expect(conflict[0].status).toBe('conflict');
    // Conflicts are NOT ledgered in v2: a retry re-evaluates against the
    // CURRENT server state, so a stale recorded payload can never regress a
    // fresher client cache.
    expect(await h.mutations.find(owner.id, 'm-2')).toBeUndefined();
    const retry = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })
    ]);
    expect(retry[0]).toEqual(conflict[0]);
    // ...and if the record moved on, the retried conflict carries the FRESH
    // version + payload rather than the original stale one.
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-3', baseVersion: 1, payload: { text: 'fresher' } })
    ]);
    const retryAfterMove = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })
    ]);
    expect(retryAfterMove[0]).toMatchObject({
      status: 'conflict',
      serverVersion: 2,
      serverPayload: { text: 'fresher' }
    });
  });

  it('rejects reuse of a clientMutationId for a different mutation', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [result] = await h.service.push(owner, [item({ entityId: 'n-2', clientMutationId: 'm-1' })]);
    expect(result).toMatchObject({ status: 'error', error: 'mutation_id_reused' });
  });

  it('rejects pushes against read-only registered entities', async () => {
    const [result] = await h.service.push(owner, [
      item({ entity: 'ro_listing', entityId: 'l-1', clientMutationId: 'm-1' })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'read_only_entity' });
  });

  it('rejects pushes for unregistered entities', async () => {
    const [result] = await h.service.push(owner, [
      item({ entity: 'nope', entityId: 'x', clientMutationId: 'm-1' })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'unknown_entity' });
  });

  it('blocks non-owners from mutating an owned record', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [result] = await h.service.push(outsider, [
      item({ entityId: 'n-1', clientMutationId: 'm-9', baseVersion: 1, payload: { text: 'hijack' } })
    ]);
    expect(result).toMatchObject({ status: 'error', error: 'forbidden' });
    expect(h.notes.get('n-1')!.text).toBe('hello');
  });

  it('lets admins mutate any record', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [result] = await h.service.push(admin, [
      item({ entityId: 'n-1', clientMutationId: 'm-9', baseVersion: 1, payload: { text: 'admin' } })
    ]);
    expect(result.status).toBe('applied');
  });

  it('blocks non-owners from deleting and tombstones owner deletes', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const [denied] = await h.service.push(outsider, [
      item({ entityId: 'n-1', clientMutationId: 'm-8', op: 'delete', payload: undefined, baseVersion: 1 })
    ]);
    expect(denied).toMatchObject({ status: 'error', error: 'forbidden' });

    const [deleted] = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-9', op: 'delete', payload: undefined, baseVersion: 1 })
    ]);
    expect(deleted).toMatchObject({ status: 'applied', newVersion: 2 });
    expect((await h.versions.current('test_note', 'n-1'))!.deleted).toBe(true);
  });

  it('emits audit + a domain event per applied item only', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })]);
    expect(h.published).toEqual(['sync.mutation.applied']);
    expect(h.audited).toEqual(['sync.push.upsert']);
  });

  it('processes batches per item: one conflict does not block siblings', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const results = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 }),
      item({ entityId: 'n-2', clientMutationId: 'm-3' })
    ]);
    expect(results.map((r) => r.status)).toEqual(['conflict', 'applied']);
  });

  it('processes different records concurrently within a batch (perf P2-7)', async () => {
    const descriptor = h.registry.get('test_note')!;
    const originalApply = descriptor.apply!;
    let inFlight = 0;
    let maxInFlight = 0;
    descriptor.apply = async (actor, pushed) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return await originalApply(actor, pushed);
      } finally {
        inFlight -= 1;
      }
    };
    const results = await h.service.push(owner, [
      item({ entityId: 'p-1', clientMutationId: 'pm-1' }),
      item({ entityId: 'p-2', clientMutationId: 'pm-2' }),
      item({ entityId: 'p-3', clientMutationId: 'pm-3' })
    ]);
    // Result order matches input order…
    expect(results.map((r) => r.entityId)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    // …but the applies overlapped (a strictly sequential loop could never).
    expect(maxInFlight).toBe(3);
  });

  it('keeps same-record items sequential within a batch (version chain preserved)', async () => {
    const descriptor = h.registry.get('test_note')!;
    const originalApply = descriptor.apply!;
    // The delay makes accidental parallelism observable as a conflict.
    descriptor.apply = async (actor, pushed) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalApply(actor, pushed);
    };
    const results = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-1' }),
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 1, payload: { text: 'v2' } })
    ]);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(results[0].newVersion).toBe(1);
    expect(results[1].newVersion).toBe(2);
    expect(h.notes.get('n-1')).toMatchObject({ text: 'v2' });
  });

  it('keeps clientMutationId reuse within one batch sequential (fail-closed on reuse)', async () => {
    const results = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-1' }),
      item({ entityId: 'n-2', clientMutationId: 'm-1' })
    ]);
    expect(results[0].status).toBe('applied');
    expect(results[1]).toMatchObject({ status: 'error', error: 'mutation_id_reused' });
  });
});

describe('SyncService.pull', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  async function seedNotes(count: number): Promise<void> {
    for (let i = 1; i <= count; i += 1) {
      await h.service.push(owner, [
        item({ entityId: `n-${i}`, clientMutationId: `seed-${i}`, payload: { text: `t${i}` } })
      ]);
    }
  }

  it('returns owned items ordered by version with a cursor', async () => {
    await seedNotes(3);
    const page = await h.service.pull(owner, 'test_note', 0, 10);
    expect(page.items.map((i) => i.entityId)).toEqual(['n-1', 'n-2', 'n-3']);
    expect(page.items[0].payload).toMatchObject({ text: 't1' });
    expect(page.cursor).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
  });

  it('pages monotonically: no overlap, cursor never regresses', async () => {
    await seedNotes(3);
    const page1 = await h.service.pull(owner, 'test_note', 0, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await h.service.pull(owner, 'test_note', page1.cursor, 2, 2);
    const ids1 = page1.items.map((i) => i.entityId);
    const ids2 = page2.items.map((i) => i.entityId);
    expect(ids2.every((id) => !ids1.includes(id))).toBe(true);
    expect(page2.cursor).toBeGreaterThanOrEqual(page1.cursor);
    expect(page2.hasMore).toBe(false);
  });

  it('scopes pulls to the caller: other users see nothing', async () => {
    await seedNotes(2);
    const page = await h.service.pull(outsider, 'test_note', 0, 10);
    expect(page.items).toHaveLength(0);
    expect(page.cursor).toBe(0);
  });

  it('serves deletes as tombstones with null payloads', async () => {
    await seedNotes(1);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-del', op: 'delete', payload: undefined, baseVersion: 1 })
    ]);
    const page = await h.service.pull(owner, 'test_note', 0, 10);
    expect(page.items).toEqual([{ entityId: 'n-1', version: 2, changeSeq: 2, deleted: true, payload: null }]);
  });

  it('serves a missing source record as a tombstone (fail-closed)', async () => {
    await seedNotes(1);
    h.notes.clear(); // source row vanished without a tombstone bump
    const page = await h.service.pull(owner, 'test_note', 0, 10);
    expect(page.items[0]).toMatchObject({ entityId: 'n-1', deleted: true, payload: null });
  });

  it('rejects unknown entities and negative cursors', async () => {
    await expect(h.service.pull(owner, 'nope', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.pull(owner, 'test_note', -1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clamps the page limit to the protocol maximum', async () => {
    await seedNotes(3);
    const page = await h.service.pull(owner, 'test_note', 0, 999_999);
    expect(page.items).toHaveLength(3); // clamped, not an error
  });

  it('records the server-side cursor for status()', async () => {
    await seedNotes(1);
    const page = await h.service.pull(owner, 'test_note', 0, 10);
    expect(await h.cursors.get(owner.id, 'test_note')).toBe(page.cursor);
  });
});

describe('SyncService.status', () => {
  it('reports per-entity server max version and cursor for the caller', async () => {
    const h = makeHarness();
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const before = await h.service.status(owner);
    const noteStatus = before.find((entry) => entry.entity === 'test_note')!;
    expect(noteStatus.serverMaxVersion).toBe(1);
    expect(noteStatus.cursor).toBe(0);

    const page = await h.service.pull(owner, 'test_note', 0, 10);
    const after = await h.service.status(owner);
    expect(after.find((entry) => entry.entity === 'test_note')!.cursor).toBe(page.cursor);
    // Read-only entities registered in the harness appear too.
    expect(after.map((entry) => entry.entity)).toContain('ro_listing');
  });

  it('scopes status to the caller', async () => {
    const h = makeHarness();
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const status = await h.service.status(outsider);
    expect(status.find((entry) => entry.entity === 'test_note')!.serverMaxVersion).toBe(0);
  });
});

/** Parity hook: the same engine behaviour holds over the pg repositories
 * (test/pg/sync.pg.spec.ts runs the repository-level contract when
 * DATABASE_URL is set); this assertion pins the port shapes the pg
 * implementations satisfy. */
describe('sync repository port parity (in-memory reference)', () => {
  it('bumpExpected CAS: insert at 0, reject stale, advance on match', async () => {
    const versions: EntityVersionRepository = new InMemoryEntityVersionRepository();
    const bump = { entity: 'e', entityId: 'id-1', ownerId: 'u', updatedBy: 'u' };
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 1 })).toBeNull();
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 0 })).toBe(1);
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 0 })).toBeNull();
    expect(await versions.bumpExpected({ ...bump, expectedVersion: 1 })).toBe(2);
  });

  it('mutation ledger record is atomic on (user, clientMutationId)', async () => {
    const mutations = new InMemorySyncMutationRepository();
    const record = {
      userId: 'u',
      clientMutationId: 'm',
      entity: 'e',
      entityId: 'id',
      op: 'upsert' as const,
      status: 'applied' as const,
      newVersion: 1,
      detail: null,
      createdAt: new Date().toISOString()
    };
    expect(await mutations.record(record)).toBe(true);
    expect(await mutations.record({ ...record, newVersion: 99 })).toBe(false);
    expect((await mutations.find('u', 'm'))!.newVersion).toBe(1);
  });

  it('stamps a global monotonic change_seq on every bump (v2 pull domain)', async () => {
    const versions: EntityVersionRepository = new InMemoryEntityVersionRepository();
    const bump = { entity: 'e', ownerId: 'u', updatedBy: 'u' };
    await versions.bump({ ...bump, entityId: 'a' });
    await versions.bump({ ...bump, entityId: 'b' });
    await versions.bump({ ...bump, entityId: 'a' });
    const a = (await versions.current('e', 'a'))!;
    const b = (await versions.current('e', 'b'))!;
    expect([a.version, a.changeSeq]).toEqual([2, 3]);
    expect([b.version, b.changeSeq]).toEqual([1, 2]);
    // listSince/maxChangeSeq operate on change_seq, not per-record version.
    const rows = await versions.listSince('e', 'u', 2, 10);
    expect(rows.map((row) => row.entityId)).toEqual(['a']);
    expect(await versions.maxChangeSeq('e', 'u')).toBe(3);
  });

  it('applyGuarded: loser never runs apply; failed apply rolls the claim back', async () => {
    const versions = new InMemoryEntityVersionRepository();
    const bump = { entity: 'e', entityId: 'id-1', ownerId: 'u', updatedBy: 'u' };
    await versions.bump(bump);
    let loserRan = false;
    const lost = await versions.applyGuarded({ ...bump, expectedVersion: 0 }, async () => {
      loserRan = true;
    });
    expect(lost).toBeNull();
    expect(loserRan).toBe(false);

    const won = await versions.applyGuarded({ ...bump, expectedVersion: 1 }, async () => 'ok');
    expect(won).toEqual({ version: 2, value: 'ok' });

    await expect(
      versions.applyGuarded({ ...bump, expectedVersion: 2 }, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect((await versions.current('e', 'id-1'))!.version).toBe(2);
  });

  it('in-memory cursor set is monotonic like the pg GREATEST (L-08)', async () => {
    const cursors = new InMemorySyncCursorRepository();
    await cursors.set('u', 'e', 5);
    await cursors.set('u', 'e', 3); // regression ignored
    expect(await cursors.get('u', 'e')).toBe(5);
    await cursors.set('u', 'e', 9);
    expect(await cursors.get('u', 'e')).toBe(9);
  });

  it('in-memory pruneOlderThan removes only stale rows, capped by limit (L-09)', async () => {
    const mutations = new InMemorySyncMutationRepository();
    const record = (id: string, createdAt: string) => ({
      userId: 'u',
      clientMutationId: id,
      entity: 'e',
      entityId: 'id',
      op: 'upsert' as const,
      status: 'applied' as const,
      newVersion: 1,
      detail: null,
      createdAt
    });
    await mutations.record(record('old-1', '2020-01-01T00:00:00.000Z'));
    await mutations.record(record('old-2', '2020-06-01T00:00:00.000Z'));
    await mutations.record(record('fresh', '2999-01-01T00:00:00.000Z'));
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 1)).toBe(1);
    expect(await mutations.find('u', 'old-1')).toBeUndefined();
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 100)).toBe(1);
    expect(await mutations.pruneOlderThan('2021-01-01T00:00:00.000Z', 100)).toBe(0);
    expect(await mutations.find('u', 'fresh')).toBeDefined();
  });
});

/* ------------------------- v2 protocol specs (FP-4) ------------------------- */

describe('SyncService.pull — v2 change_seq cursors (V-01)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('the F-01 walkthrough: A(v5)/B(v2); pull since=5 returns B (per-record versions cannot hide it)', async () => {
    // Record A edited 5 times → version 5, change_seq 1..5 (row seq = 5).
    await h.service.push(owner, [item({ entityId: 'a', clientMutationId: 'a-1', payload: { text: 'a1' } })]);
    for (let i = 2; i <= 5; i += 1) {
      await h.service.push(owner, [
        item({ entityId: 'a', clientMutationId: `a-${i}`, baseVersion: i - 1, payload: { text: `a${i}` } })
      ]);
    }
    // Record B edited twice → version 2, change_seq 6..7 (row seq = 7).
    await h.service.push(owner, [item({ entityId: 'b', clientMutationId: 'b-1', payload: { text: 'b1' } })]);
    await h.service.push(owner, [
      item({ entityId: 'b', clientMutationId: 'b-2', baseVersion: 1, payload: { text: 'b2' } })
    ]);

    // v1 semantics compared `version > since` (2 > 5 = false) and lost B
    // forever. v2 compares change_seq > since (7 > 5) and delivers it.
    const page = await h.service.pull(owner, 'test_note', 5, 10, 2);
    expect(page.items.map((i) => [i.entityId, i.version, i.changeSeq])).toEqual([['b', 2, 7]]);
    expect(page.cursor).toBe(7);
    expect(page.hasMore).toBe(false);
  });

  it('stays monotonic under interleaved edits: no skipped records, cursor never regresses', async () => {
    await h.service.push(owner, [item({ entityId: 'a', clientMutationId: 'a-1' })]);
    await h.service.push(owner, [item({ entityId: 'b', clientMutationId: 'b-1' })]);

    const page1 = await h.service.pull(owner, 'test_note', 0, 1);
    expect(page1.items.map((i) => i.entityId)).toEqual(['a']);
    expect(page1.hasMore).toBe(true);

    // Interleave an edit to the already-delivered record A before page 2.
    await h.service.push(owner, [
      item({ entityId: 'a', clientMutationId: 'a-2', baseVersion: 1, payload: { text: 'a2' } })
    ]);

    const page2 = await h.service.pull(owner, 'test_note', page1.cursor, 10, 2);
    // B (unseen) and A's NEW change both arrive; the cursor only advances.
    expect(page2.items.map((i) => i.entityId)).toEqual(['b', 'a']);
    expect(page2.cursor).toBeGreaterThan(page1.cursor);

    const empty = await h.service.pull(owner, 'test_note', page2.cursor, 10, 2);
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBe(page2.cursor);
  });

  it('rejects a legacy (v1) non-zero cursor with a resync-required signal', async () => {
    await h.service.push(owner, [item({ entityId: 'a', clientMutationId: 'a-1' })]);
    // No protocol version declared with a non-zero cursor → 409 ConflictException.
    const legacy = h.service.pull(owner, 'test_note', 1, 10);
    await expect(legacy).rejects.toBeInstanceOf(ConflictException);
    await expect(legacy).rejects.toThrow(/resync_required/);
    // An explicit v=1 is rejected the same way; v=2 is accepted.
    await expect(h.service.pull(owner, 'test_note', 1, 10, 1)).rejects.toBeInstanceOf(
      ConflictException
    );
    const ok = await h.service.pull(owner, 'test_note', 1, 10, 2);
    expect(ok.protocol).toBe(2);
    // since=0 (full resync) is always accepted, with or without v — that is
    // the recovery path the resync-required signal points clients at.
    const fresh = await h.service.pull(owner, 'test_note', 0, 10);
    expect(fresh.items).toHaveLength(1);
  });
});

describe('SyncService.push — concurrent claim race (V-18)', () => {
  it('two pushes at baseVersion=3: exactly one applied, loser conflict, source row holds only the winner', async () => {
    const h = makeHarness();
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 's-1', payload: { text: 'v1' } })]);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 's-2', baseVersion: 1, payload: { text: 'v2' } })
    ]);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 's-3', baseVersion: 2, payload: { text: 'v3' } })
    ]);

    // Race two pushes based on v3. The in-memory driver is single-threaded,
    // but both pushes interleave at await points — exactly one claim can win.
    const [first, second] = await Promise.all([
      h.service.push(owner, [
        item({ entityId: 'n-1', clientMutationId: 'r-1', baseVersion: 3, payload: { text: 'racer-1' } })
      ]),
      h.service.push(owner, [
        item({ entityId: 'n-1', clientMutationId: 'r-2', baseVersion: 3, payload: { text: 'racer-2' } })
      ])
    ]);
    const results = [first[0], second[0]];
    const applied = results.filter((r) => r.status === 'applied');
    const conflicts = results.filter((r) => r.status === 'conflict');
    expect(applied).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(applied[0].newVersion).toBe(4);
    expect(conflicts[0].serverVersion).toBe(4);
    // The loser's payload never touched the source row, and the ledger and
    // the source row agree.
    const winnerText = applied[0].clientMutationId === 'r-1' ? 'racer-1' : 'racer-2';
    expect(h.notes.get('n-1')!.text).toBe(winnerText);
    expect((await h.versions.current('test_note', 'n-1'))!.version).toBe(4);
  });
});

describe('SyncService.push — tombstone ownership (V-63)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  async function seedTombstone(): Promise<void> {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 1, payload: { text: 'v2' } })
    ]);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-3', baseVersion: 2, payload: { text: 'v3' } })
    ]);
    await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-4', baseVersion: 3, op: 'delete', payload: undefined })
    ]);
    // Tombstone: v4, deleted, owner = user-1.
    expect((await h.versions.current('test_note', 'n-1'))).toMatchObject({
      version: 4,
      ownerId: owner.id,
      deleted: true
    });
    expect(h.notes.has('n-1')).toBe(false);
  }

  it('rejects create-over-foreign-tombstone even with the correct baseVersion; owner preserved', async () => {
    await seedTombstone();
    const [result] = await h.service.push(outsider, [
      item({ entityId: 'n-1', clientMutationId: 'x-1', baseVersion: 4, payload: { text: 'takeover' } })
    ]);
    expect(result.status).toBe('error');
    expect(result.error).toBe('forbidden');
    // The ledger is untouched: the tombstone still belongs to the original owner.
    expect((await h.versions.current('test_note', 'n-1'))).toMatchObject({
      version: 4,
      ownerId: owner.id,
      deleted: true
    });
    expect(h.notes.has('n-1')).toBe(false);
  });

  it('does not leak serverVersion to a foreign caller probing a tombstone (no CAS oracle)', async () => {
    await seedTombstone();
    // Wrong-guess probe: without the fix this returned conflict +
    // serverVersion 4, a one-shot oracle for the takeover CAS.
    const [probe] = await h.service.push(outsider, [
      item({ entityId: 'n-1', clientMutationId: 'x-1', baseVersion: 1, payload: { text: 'probe' } })
    ]);
    expect(probe).toMatchObject({ status: 'error', error: 'forbidden' });
    expect('serverVersion' in probe).toBe(false);
    expect('serverPayload' in probe).toBe(false);
  });

  it('lets the original owner re-create over their own tombstone (CAS still applies)', async () => {
    await seedTombstone();
    const [result] = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-5', baseVersion: 4, payload: { text: 'reborn' } })
    ]);
    expect(result).toMatchObject({ status: 'applied', newVersion: 5 });
    expect(h.notes.get('n-1')).toMatchObject({ ownerId: owner.id, text: 'reborn' });
  });
});
