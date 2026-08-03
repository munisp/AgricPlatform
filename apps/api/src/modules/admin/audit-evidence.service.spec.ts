import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuditService, canonicalJSON } from '../../core/audit.service.js';
import { createInMemoryAuditRepository } from '../../database/repositories/audit.repository.js';
import { AuditEvidenceService } from './audit-evidence.service.js';

function build() {
  const repository = createInMemoryAuditRepository();
  const audit = new AuditService(repository);
  const evidence = new AuditEvidenceService(audit);
  return { repository, audit, evidence };
}

async function recordThree(audit: AuditService) {
  await audit.record({ actorId: 'user-a', action: 'admin.user.roles_updated', entityType: 'user', entityId: 'u1' });
  await audit.record({ actorId: 'user-b', action: 'compliance.consent_recorded', entityType: 'compliance_consent', entityId: 'c1' });
  await audit.record({ actorId: 'user-a', action: 'compliance.dsr_rejected', entityType: 'data_subject_request', entityId: 'd1' });
}

describe('AuditEvidenceService (Wave COMP)', () => {
  it('packs the chain with a passing verification and the slice head hash', async () => {
    const { audit, evidence } = build();
    await recordThree(audit);
    const pack = await evidence.evidencePack();
    expect(pack.eventCount).toBe(3);
    expect(pack.verification).toEqual({ valid: true, checked: 3 });
    expect(pack.chainHead).toBe(pack.events[2].hash);
    expect(pack.range).toEqual({ from: null, to: null });
  });

  it('produces a stable payloadHash across calls over the same data', async () => {
    const { audit, evidence } = build();
    await recordThree(audit);
    const first = await evidence.evidencePack();
    const second = await evidence.evidencePack();
    expect(first.payloadHash).toBe(second.payloadHash);
    expect(first.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('payloadHash is the sha256 of the canonical {range, events, verification} payload', async () => {
    const { audit, evidence } = build();
    await recordThree(audit);
    const pack = await evidence.evidencePack();
    const expected = `sha256:${createHash('sha256')
      .update(
        canonicalJSON({ range: pack.range, events: pack.events, verification: pack.verification })
      )
      .digest('hex')}`;
    expect(pack.payloadHash).toBe(expected);
  });

  it('bounds the slice by ISO createdAt and still verifies the range', async () => {
    const { audit, evidence } = build();
    await recordThree(audit);
    const all = await audit.list();
    const pack = await evidence.evidencePack(all[1].createdAt, all[1].createdAt);
    expect(pack.range).toEqual({ from: all[1].createdAt, to: all[1].createdAt });
    expect(pack.eventCount).toBeGreaterThanOrEqual(1);
    for (const event of pack.events) {
      expect(event.createdAt >= all[1].createdAt).toBe(true);
      expect(event.createdAt <= all[1].createdAt).toBe(true);
    }
    expect(pack.verification.valid).toBe(true);
    expect(pack.chainHead).toBe(pack.events[pack.events.length - 1].hash);
  });

  it('rejects malformed or inverted bounds', async () => {
    const { evidence } = build();
    await expect(evidence.evidencePack('not-a-date')).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      evidence.evidencePack('2026-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('flags a tampered event inside the slice', async () => {
    const { repository, audit, evidence } = build();
    await recordThree(audit);
    // Simulate a database-level tamper: rewrite history in place.
    const stored = await repository.list();
    stored[1].action = 'admin.user.status_changed';
    const pack = await evidence.evidencePack();
    expect(pack.verification.valid).toBe(false);
    expect(pack.verification.brokenAt).toBe(stored[1].id);
  });

  it('empty ranges produce an empty, valid pack', async () => {
    const { audit, evidence } = build();
    await recordThree(audit);
    const pack = await evidence.evidencePack('2030-01-01T00:00:00.000Z', '2030-06-01T00:00:00.000Z');
    expect(pack.eventCount).toBe(0);
    expect(pack.verification).toEqual({ valid: true, checked: 0 });
    expect(pack.chainHead).toBeNull();
  });
});
