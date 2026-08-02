import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@agric-platform/shared';
import { createInMemoryAuditRepository } from '../database/repositories/audit.repository.js';
import { AuditService, hashAuditEvent } from './audit.service.js';

async function buildChain(count: number) {
  const repo = createInMemoryAuditRepository();
  const service = new AuditService(repo);
  const events: AuditEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(
      await service.record({
        actorId: 'admin',
        action: `action.${i}`,
        entityType: 'test',
        entityId: `e${i}`
      })
    );
  }
  return { repo, service, events };
}

describe('AuditService.verify range walks (Wave P)', () => {
  it('reports the number of checked events on a full walk', async () => {
    const { service } = await buildChain(4);
    expect(await service.verify()).toEqual({ valid: true, checked: 4 });
  });

  it('verifies a contiguous range, trusting the slice head link', async () => {
    const { service, events } = await buildChain(5);
    const result = await service.verify({ fromId: events[1].id, toId: events[3].id });
    expect(result).toEqual({ valid: true, checked: 3 });
  });

  it('reports the first broken link inside the range', async () => {
    const { service, repo, events } = await buildChain(4);
    // Tamper with event 2's stored payload hash chain: rewrite event 3's prevHash.
    const tampered = { ...events[3], prevHash: 'f'.repeat(64) };
    await repo.record(tampered as AuditEvent);
    void events;
    const result = await service.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(tampered.id);
  });

  it('fails closed for unknown range bounds', async () => {
    const { service } = await buildChain(2);
    expect((await service.verify({ fromId: 'missing' })).valid).toBe(false);
    expect((await service.verify({ toId: 'missing' })).valid).toBe(false);
  });

  it('detects payload tampering: a rehashed forgery breaks the next link', async () => {
    const { service, repo, events } = await buildChain(3);
    const { hash, ...unsigned } = events[1];
    void hash;
    const forged = {
      ...unsigned,
      metadata: { tampered: true },
      hash: hashAuditEvent({ ...unsigned, metadata: { tampered: true } }, unsigned.prevHash)
    } as AuditEvent;
    // The forged copy appends where history diverges; its prevHash points at
    // event 0 while the running tail is event 2's hash.
    await repo.record(forged);
    const result = await service.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(events[1].id);
  });
});
