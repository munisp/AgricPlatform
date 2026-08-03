import { BadRequestException } from '@nestjs/common';
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
      if (item.op === 'delete') {
        notes.delete(item.entityId);
        const v = await versions.bumpExpected({
          entity: 'test_note',
          entityId: item.entityId,
          ownerId: actor.id,
          updatedBy: actor.id,
          deleted: true,
          expectedVersion: item.baseVersion
        });
        if (v === null) throw new Error('version race');
        return v;
      }
      notes.set(item.entityId, {
        ownerId: notes.get(item.entityId)?.ownerId ?? actor.id,
        text: String(item.payload?.text ?? '')
      });
      const v = await versions.bumpExpected({
        entity: 'test_note',
        entityId: item.entityId,
        ownerId: notes.get(item.entityId)!.ownerId,
        updatedBy: actor.id,
        expectedVersion: item.baseVersion
      });
      if (v === null) throw new Error('version race');
      return v;
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

  it('replays a recorded conflict outcome on retry', async () => {
    await h.service.push(owner, [item({ entityId: 'n-1', clientMutationId: 'm-1' })]);
    const conflict = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })
    ]);
    const replay = await h.service.push(owner, [
      item({ entityId: 'n-1', clientMutationId: 'm-2', baseVersion: 0 })
    ]);
    expect(replay[0]).toEqual(conflict[0]);
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
    const page2 = await h.service.pull(owner, 'test_note', page1.cursor, 2);
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
    expect(page.items).toEqual([{ entityId: 'n-1', version: 2, deleted: true, payload: null }]);
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
});
