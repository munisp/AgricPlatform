import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@agric-platform/shared';
import { createInMemoryAuditRepository } from '../database/repositories/audit.repository.js';
import { AuditService, canonicalJSON, GENESIS_HASH, hashAuditEvent } from './audit.service.js';

function makeService() {
  const repository = createInMemoryAuditRepository();
  return { audit: new AuditService(repository), repository };
}

const input = (action: string, entityId: string) => ({
  actorId: 'admin-1',
  action,
  entityType: 'user',
  entityId: entityId
});

describe('canonicalJSON', () => {
  it('is key-order independent', () => {
    expect(canonicalJSON({ b: 1, a: { d: [2, 3], c: 'x' } })).toBe(
      canonicalJSON({ a: { c: 'x', d: [2, 3] }, b: 1 })
    );
  });
});

describe('AuditService hash chain', () => {
  it('chains records from the genesis hash and verifies clean', async () => {
    const { audit } = makeService();
    const first = await audit.record(input('user.suspend', 'user-1'));
    const second = await audit.record(input('user.activate', 'user-1'));

    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.prevHash).toBe(first.hash);
    // Hash covers the whole payload (minus the hash itself) + prevHash.
    const { hash, ...unsigned } = second;
    expect(hash).toBe(hashAuditEvent(unsigned, second.prevHash!));

    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 2 });
  });

  it('reports brokenAt when an event payload is tampered with', async () => {
    const { audit, repository } = makeService();
    await audit.record(input('user.suspend', 'user-1'));
    const victim = await audit.record(input('user.activate', 'user-1'));
    await audit.record(input('user.suspend', 'user-2'));

    // Tamper with the middle record in the store.
    const stored = await repository.list();
    stored[1].metadata = { backdated: true };

    const result = await audit.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(victim.id);
  });

  it('reports brokenAt when a prevHash link is rewritten', async () => {
    const { audit, repository } = makeService();
    await audit.record(input('a', 'e-1'));
    const second = await audit.record(input('b', 'e-2'));
    (await repository.list())[1].prevHash = GENESIS_HASH;

    const result = await audit.verify();
    expect(result).toEqual({ valid: false, brokenAt: second.id, checked: 1 });
  });

  it('flags records without hash fields (legacy or stripped)', async () => {
    const { audit, repository } = makeService();
    const event = await audit.record(input('a', 'e-1'));
    delete (await repository.list())[0].hash;
    await expect(audit.verify()).resolves.toEqual({ valid: false, brokenAt: event.id, checked: 0 });
  });

  it('verifies an empty log as valid', async () => {
    const { audit } = makeService();
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 0 });
  });

  it('resumes the chain from the repository after a restart', async () => {
    const { audit, repository } = makeService();
    const first = await audit.record(input('a', 'e-1'));

    // New service instance (restart) over the same repository.
    const restarted = new AuditService(repository);
    const second = await restarted.record(input('b', 'e-2'));
    expect(second.prevHash).toBe(first.hash);
    await expect(restarted.verify()).resolves.toEqual({ valid: true, checked: 2 });
  });

  it('carries an optional requestId into the record', async () => {
    const { audit } = makeService();
    const withId = await audit.record({ ...input('a', 'e-1'), requestId: 'req-42' });
    const withoutId = await audit.record(input('b', 'e-2'));
    expect(withId.requestId).toBe('req-42');
    expect(withoutId.requestId).toBeUndefined();
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 2 });
  });

  it('serializes concurrent record() calls into a single valid chain (audit C2-11)', async () => {
    const { audit } = makeService();
    // N interleaved writers: the repository's atomic append must link each
    // event to a distinct parent — no two events may share a prevHash.
    const recorded = await Promise.all(
      Array.from({ length: 25 }, (_, i) => audit.record(input(`bulk.${i}`, `e-${i}`)))
    );
    expect(recorded).toHaveLength(25);
    expect(new Set(recorded.map((event) => event.prevHash)).size).toBe(25);
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 25 });
  });

  it('detects a forged fork: two events claiming the same prevHash', async () => {
    const { audit, repository } = makeService();
    const first = await audit.record(input('a', 'e-1'));
    await audit.record(input('b', 'e-2'));

    // Forged sibling branch: a well-formed event whose prevHash duplicates
    // event 2's parent (what the pre-fix concurrent writer would persist).
    const forgedUnsigned: Omit<AuditEvent, 'hash'> = {
      id: 'audit-forged-fork',
      actorId: 'attacker',
      action: 'user.suspend',
      entityType: 'user',
      entityId: 'user-9',
      metadata: {},
      createdAt: new Date().toISOString(),
      prevHash: first.hash
    };
    const forged: AuditEvent = {
      ...forgedUnsigned,
      hash: hashAuditEvent(forgedUnsigned, first.hash!)
    };
    await repository.record(forged);

    const result = await audit.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(forged.id);
    expect(result.checked).toBe(2);
  });
});
