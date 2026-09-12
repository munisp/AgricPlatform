import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryFraudSentinelRepository,
  type FraudAlertRecord
} from './fraud.repository.js';

/**
 * Fraud repository contract tests (in-memory implementation — the pg
 * implementation compiles the same semantics: dedup-key ON CONFLICT upsert,
 * composite-PK rule immutability, guarded CAS transitions).
 */

function alertFixture(overrides: Partial<FraudAlertRecord> = {}) {
  return {
    id: 'falert-1',
    dedupKey: 'rule:1:event-1:agent:agent-1',
    ruleCode: 'rule',
    ruleVersion: 1,
    subjectType: 'agent' as const,
    subjectId: 'agent-1',
    severity: 'high' as const,
    evidence: { eventIds: ['event-1'] },
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

describe('InMemoryFraudSentinelRepository', () => {
  it('upsertAlert is idempotent on dedup_key (replay converges, created=false)', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    const first = await repo.upsertAlert(alertFixture());
    expect(first.created).toBe(true);
    expect(first.alert.status).toBe('open');

    const replay = await repo.upsertAlert(alertFixture({ id: 'falert-twin' }));
    expect(replay.created).toBe(false);
    expect(replay.alert.id).toBe('falert-1'); // stored row wins, twin discarded
    expect(await repo.findAlerts({})).toHaveLength(1);
  });

  it('rule versions are immutable; currentRule returns the highest version', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    const base = {
      code: 'rule',
      description: 'd',
      params: { a: 1 },
      enabled: true,
      createdBy: 'test',
      createdAt: '2026-08-01T00:00:00.000Z'
    };
    await repo.insertRuleVersion({ ...base, version: 1 });
    await expect(repo.insertRuleVersion({ ...base, version: 1 })).rejects.toBeInstanceOf(
      ConflictException
    );
    await repo.insertRuleVersion({ ...base, version: 2, params: { a: 2 } });
    expect((await repo.currentRule('rule'))?.params).toEqual({ a: 2 });
    expect(await repo.listRules()).toHaveLength(2);
  });

  it('enabledRules reports the latest version only and honours the kill-switch', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    const base = {
      code: 'rule',
      description: 'd',
      params: {},
      enabled: true,
      createdBy: 'test',
      createdAt: '2026-08-01T00:00:00.000Z'
    };
    await repo.insertRuleVersion({ ...base, version: 1 });
    await repo.insertRuleVersion({ ...base, version: 2, enabled: false });
    expect(await repo.enabledRules()).toHaveLength(0);
    await repo.setRuleEnabled('rule', 2, true);
    expect((await repo.enabledRules()).map((rule) => rule.version)).toEqual([2]);
    expect(await repo.setRuleEnabled('rule', 9, true)).toBeUndefined();
  });

  it('transitionAlert is a guarded open → confirmed|dismissed CAS', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    await repo.upsertAlert(alertFixture());
    const updated = await repo.transitionAlert(
      'falert-1',
      { status: 'confirmed', resolvedBy: 'officer', resolvedAt: '2026-08-02T00:00:00.000Z' },
      { status: 'open' }
    );
    expect(updated.status).toBe('confirmed');
    await expect(
      repo.transitionAlert(
        'falert-1',
        { status: 'dismissed', resolvedBy: 'other', resolvedAt: '2026-08-02T01:00:00.000Z' },
        { status: 'open' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('alert filters + per-rule hit counts', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    await repo.upsertAlert(alertFixture());
    await repo.upsertAlert(
      alertFixture({
        id: 'falert-2',
        dedupKey: 'other:1:event-2:agent:agent-2',
        ruleCode: 'other',
        subjectId: 'agent-2'
      })
    );
    expect(await repo.findAlerts({ ruleCode: 'other' })).toHaveLength(1);
    expect(await repo.findAlerts({ status: 'open' })).toHaveLength(2);
    expect(await repo.findAlerts({ status: 'confirmed' })).toHaveLength(0);
    expect(await repo.countAlertsByRule()).toEqual({ rule: 1, other: 1 });
  });

  it('case lifecycle with guarded resolve CAS', async () => {
    const repo = createInMemoryFraudSentinelRepository();
    await repo.createCase({
      id: 'fcase-1',
      alertIds: ['falert-1'],
      status: 'open',
      createdBy: 'admin',
      createdAt: '2026-08-01T00:00:00.000Z'
    });
    await expect(
      repo.createCase({
        id: 'fcase-1',
        alertIds: [],
        status: 'open',
        createdBy: 'admin',
        createdAt: '2026-08-01T00:00:00.000Z'
      })
    ).rejects.toBeInstanceOf(ConflictException);

    const resolved = await repo.resolveCase(
      'fcase-1',
      { resolution: 'done', resolvedBy: 'officer', resolvedAt: '2026-08-02T00:00:00.000Z' },
      { status: 'open' }
    );
    expect(resolved.status).toBe('resolved');
    await expect(
      repo.resolveCase(
        'fcase-1',
        { resolution: 'again', resolvedBy: 'officer', resolvedAt: '2026-08-03T00:00:00.000Z' },
        { status: 'open' }
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await repo.findCases({ status: 'open' })).toHaveLength(0);
    expect(await repo.findCases({ status: 'resolved' })).toHaveLength(1);
  });
});
