import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryAgentCaseRepository,
  createInMemoryVoiceSessionRepository,
  createInMemoryVoiceTurnRepository,
  type AgentCaseRecord,
  type VoiceSessionRecord
} from './voice.repository.js';

function sessionRecord(overrides: Partial<VoiceSessionRecord> = {}): VoiceSessionRecord {
  return {
    id: 'vsession-1',
    channel: 'ussd',
    state: 'intake',
    phone: '+2348012345678',
    locale: 'en',
    menuState: { menu: 'crop' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function caseRecord(overrides: Partial<AgentCaseRecord> = {}): AgentCaseRecord {
  return {
    id: 'vcase-1',
    sessionId: 'vsession-1',
    phone: '+2348012345678',
    channel: 'ussd',
    status: 'open',
    reason: 'no_grounding',
    priority: 'high',
    slaDueAt: '2026-01-02T00:00:00.000Z',
    citationChunkIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('InMemoryVoiceSessionRepository', () => {
  it('creates, reads, updates and filters', async () => {
    const repo = createInMemoryVoiceSessionRepository();
    await repo.create(sessionRecord());
    await repo.create(sessionRecord({ id: 'vsession-2', state: 'escalated', phone: '+2348099999999' }));
    expect((await repo.getById('vsession-1')).phone).toBe('+2348012345678');
    await expect(repo.getById('missing')).rejects.toBeInstanceOf(NotFoundException);

    const updated = await repo.update('vsession-1', { state: 'triage', crop: 'maize' });
    expect(updated.state).toBe('triage');
    expect(updated.updatedAt > updated.createdAt || updated.updatedAt >= updated.createdAt).toBe(true);

    expect(await repo.find({ state: 'escalated' })).toHaveLength(1);
    expect(await repo.find({ phone: '+2348012345678' })).toHaveLength(1);
  });
});

describe('InMemoryVoiceTurnRepository', () => {
  it('indexes turns per session in order', async () => {
    const repo = createInMemoryVoiceTurnRepository();
    const speakers = ['farmer', 'assistant', 'farmer'] as const;
    for (const speaker of speakers) {
      const next = await repo.nextIndex('vsession-1');
      await repo.create({
        id: `vturn-${next}`,
        sessionId: 'vsession-1',
        turnIndex: next,
        speaker,
        text: `turn ${next}`,
        citedChunkIds: [],
        createdAt: '2026-01-01T00:00:00.000Z'
      });
    }
    const transcript = await repo.listForSession('vsession-1');
    expect(transcript.map((t) => t.turnIndex)).toEqual([1, 2, 3]);
    expect(await repo.nextIndex('vsession-1')).toBe(4);
  });
});

describe('InMemoryAgentCaseRepository', () => {
  it('orders the queue by SLA deadline and filters by status/overdue', async () => {
    const repo = createInMemoryAgentCaseRepository();
    await repo.create(caseRecord({ id: 'vcase-late', slaDueAt: '2026-01-05T00:00:00.000Z' }));
    await repo.create(caseRecord({ id: 'vcase-early', slaDueAt: '2026-01-02T00:00:00.000Z' }));
    const queue = await repo.find({});
    expect(queue.map((c) => c.id)).toEqual(['vcase-early', 'vcase-late']);

    const overdue = await repo.find({ slaDueAtOrBefore: '2026-01-03T00:00:00.000Z' });
    expect(overdue.map((c) => c.id)).toEqual(['vcase-early']);

    const updated = await repo.update('vcase-early', {
      status: 'resolved',
      assignedAgentId: 'user-agent-1'
    });
    expect(updated.status).toBe('resolved');
    expect(await repo.find({ status: 'open' })).toHaveLength(1);
    expect(await repo.find({ assignedAgentId: 'user-agent-1' })).toHaveLength(1);
  });
});
