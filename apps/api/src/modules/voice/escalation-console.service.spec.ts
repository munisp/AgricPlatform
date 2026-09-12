import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryEscalationCaseRepository } from '../../database/repositories/escalation-console.repository.js';
import type { DeliveryResult } from '../integrations/adapters.js';
import type { IntegrationsService } from '../integrations/integrations.service.js';
import {
  EscalationConsoleService,
  renderAnswerMessage
} from './escalation-console.service.js';

const agronomistA = { id: 'agronomist-a', roles: ['agronomist'] } as User;
const agronomistB = { id: 'agronomist-b', roles: ['agronomist'] } as User;
const supervisor = { id: 'supervisor-1', roles: ['supervisor'] } as User;
const farmer = { id: 'farmer-1', roles: ['farmer'] } as User;
const admin = { id: 'admin-1', roles: ['admin'] } as User;

const delivered: DeliveryResult = {
  delivered: true,
  provider: 'termii',
  driver: 'sandbox',
  providerRef: 'termii-test-1',
  note: 'Termii SMS accepted for delivery'
};
const stubFailed: DeliveryResult = {
  delivered: false,
  provider: 'termii',
  driver: 'stub',
  providerRef: 'termii-stub-1',
  note: 'Simulated sms delivery via stub driver (no external network call; message NOT sent)'
};

type DeliverFn = (
  channel: string,
  message: { to: string; text: string }
) => Promise<DeliveryResult>;

function build(deliver: DeliverFn = async () => delivered) {
  const cases = createInMemoryEscalationCaseRepository();
  const agentCases = {
    getById: vi.fn(async () => {
      throw new NotFoundException('no agent case');
    })
  };
  const sessions = { getById: vi.fn() };
  const events = { publish: vi.fn().mockResolvedValue({}), on: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({}) };
  const integrations = { deliver: vi.fn(deliver) };
  const service = new EscalationConsoleService(
    cases,
    agentCases as never,
    sessions as never,
    events as unknown as DomainEventsService,
    audit as unknown as AuditService,
    integrations as unknown as IntegrationsService,
    undefined,
    { AGRONOMIST_SLA_BUSINESS_HOURS: '4' } as NodeJS.ProcessEnv
  );
  return { service, cases, events, audit, integrations };
}

async function seedQueuedCase(
  ctx: { cases: ReturnType<typeof createInMemoryEscalationCaseRepository> },
  overrides: Record<string, unknown> = {}
) {
  const now = new Date().toISOString();
  return ctx.cases.create({
    id: (overrides.id as string) ?? 'ecase-1',
    sessionId: 'vsession-1',
    agentCaseId: 'vcase-1',
    userId: 'farmer-1',
    phone: '+2348011111111',
    channel: 'sms',
    cohort: 'dry-season-2026',
    topic: 'maize',
    locale: 'en',
    priority: 'normal',
    status: 'queued',
    slaDueAt: new Date(Date.now() + 3_600_000).toISOString(),
    deliveryStatus: 'pending',
    deliveryAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('claim CAS race', () => {
  it('two agronomists claim concurrently — exactly one winner, loser 409', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases });
    const results = await Promise.allSettled([
      service.claimCase(agronomistA, 'ecase-1'),
      service.claimCase(agronomistB, 'ecase-1')
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it('the winner is recorded as assignee with an honest 409 state', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    await expect(service.claimCase(agronomistB, 'ecase-1')).rejects.toThrow(
      'Escalation case ecase-1 is already assigned (assignee agronomist-a)'
    );
  });

  it('publishes voice.escalation.claimed once, for the winner only', async () => {
    const { service, cases, events } = build();
    await seedQueuedCase({ cases });
    await Promise.allSettled([
      service.claimCase(agronomistA, 'ecase-1'),
      service.claimCase(agronomistB, 'ecase-1')
    ]);
    const claimed = vi
      .mocked(events.publish)
      .mock.calls.filter(([name]) => name === 'voice.escalation.claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0][1]).toMatchObject({ caseId: 'ecase-1', tenantId: 'default' });
  });

  it('rejects farmers and anonymous callers from the queue', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases });
    await expect(service.claimCase(farmer, 'ecase-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.claimCase(null, 'ecase-1')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.listCases(farmer)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lists queued cases soonest-deadline-first', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases }, {
      id: 'ecase-late',
      agentCaseId: 'vcase-2',
      slaDueAt: '2026-09-15T12:00:00.000Z'
    });
    await seedQueuedCase({ cases }, {
      id: 'ecase-early',
      agentCaseId: 'vcase-3',
      slaDueAt: '2026-09-14T08:00:00.000Z'
    });
    const queue = await service.listCases(agronomistA, { status: 'queued' });
    expect(queue.map((record) => record.id)).toEqual(['ecase-early', 'ecase-late']);
  });
});

describe('answer dispatch', () => {
  it('renders the farmer SMS with topic, case id and the answer text', async () => {
    const { cases } = build();
    const record = await seedQueuedCase({ cases });
    const text = renderAnswerMessage(record, '  Spray only at dusk.  ');
    expect(text).toContain('about maize');
    expect(text).toContain('case ecase-1');
    expect(text).toContain('Spray only at dusk.');
    // Multi-line body (template literal with real newlines).
    expect(text.split(String.fromCharCode(10)).length).toBeGreaterThan(1);
  });

  it('confirmed delivery flips assigned → answered with the histogram event', async () => {
    const { service, cases, events, integrations } = build();
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    const result = await service.answerCase(agronomistA, 'ecase-1', {
      answerText: 'Scout twice weekly; hand-pick larvae.'
    });
    expect(result.delivery.delivered).toBe(true);
    expect(result.escalationCase.status).toBe('answered');
    expect(result.escalationCase.deliveryStatus).toBe('delivered');
    expect(result.escalationCase.answeredAt).toBeTruthy();
    expect(vi.mocked(integrations.deliver).mock.calls[0][0]).toBe('sms');
    expect(vi.mocked(integrations.deliver).mock.calls[0][1].to).toBe('+2348011111111');
    const answered = vi
      .mocked(events.publish)
      .mock.calls.filter(([name]) => name === 'voice.escalation.answered');
    expect(answered).toHaveLength(1);
  });

  it('FAIL-CLOSED: stub SMS records the answer but keeps the case assigned with delivery failed', async () => {
    const { service, cases, events } = build(async () => stubFailed);
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    const result = await service.answerCase(agronomistA, 'ecase-1', {
      answerText: 'Apply neem extract at dusk.'
    });
    expect(result.delivery.delivered).toBe(false);
    expect(result.escalationCase.status).toBe('assigned');
    expect(result.escalationCase.answerText).toBe('Apply neem extract at dusk.');
    expect(result.escalationCase.deliveryStatus).toBe('failed');
    expect(result.escalationCase.deliveryAttempts).toBe(1);
    expect(result.escalationCase.answeredAt).toBeUndefined();
    // Never fabricated: no answered event while the channel did not confirm.
    expect(
      vi.mocked(events.publish).mock.calls.filter(([n]) => n === 'voice.escalation.answered')
    ).toHaveLength(0);
  });

  it('provider errors become honest failed attempts (no 5xx, answer retained)', async () => {
    const { service, cases } = build(async () => {
      throw new Error('connect ECONNREFUSED termii');
    });
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    const result = await service.answerCase(agronomistA, 'ecase-1', { answerText: 'Hold off.' });
    expect(result.delivery.delivered).toBe(false);
    expect(result.delivery.note).toContain('ECONNREFUSED');
    expect(result.escalationCase.status).toBe('assigned');
    expect(result.escalationCase.deliveryStatus).toBe('failed');
  });

  it('rejects answers on queued cases and from non-assignees', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases });
    await expect(
      service.answerCase(agronomistA, 'ecase-1', { answerText: 'x' })
    ).rejects.toBeInstanceOf(ConflictException);
    await service.claimCase(agronomistA, 'ecase-1');
    await expect(
      service.answerCase(agronomistB, 'ecase-1', { answerText: 'x' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Admin may answer on the assignee's behalf (ops takeover).
    const result = await service.answerCase(admin, 'ecase-1', { answerText: 'ok' });
    expect(result.escalationCase.status).toBe('answered');
  });
});

describe('quality sampling (supervisor)', () => {
  async function answeredCase(deliver?: DeliverFn) {
    const ctx = build(deliver);
    await seedQueuedCase(ctx);
    await ctx.service.claimCase(agronomistA, 'ecase-1');
    await ctx.service.answerCase(agronomistA, 'ecase-1', { answerText: 'Scout weekly.' });
    return ctx;
  }

  it('records a supervisor score and emits voice.escalation.quality_scored', async () => {
    const { service, events } = await answeredCase();
    const result = await service.scoreQuality(supervisor, 'ecase-1', { score: 4 });
    expect(result.escalationCase.qualityScore).toBe(4);
    expect(result.escalationCase.qualityScoredBy).toBe('supervisor-1');
    const scored = vi
      .mocked(events.publish)
      .mock.calls.filter(([name]) => name === 'voice.escalation.quality_scored');
    expect(scored).toHaveLength(1);
    expect(scored[0][1]).toMatchObject({ caseId: 'ecase-1', score: 4 });
  });

  it('close=true transitions answered → closed', async () => {
    const { service } = await answeredCase();
    const result = await service.scoreQuality(supervisor, 'ecase-1', { score: 5, close: true });
    expect(result.escalationCase.status).toBe('closed');
  });

  it('rejects agronomists, invalid scores and unanswered cases', async () => {
    const { service } = await answeredCase();
    await expect(
      service.scoreQuality(agronomistA, 'ecase-1', { score: 4 })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.scoreQuality(supervisor, 'ecase-1', { score: 6 })).rejects.toThrow(
      /between 1 and 5/
    );
    await expect(service.scoreQuality(supervisor, 'ecase-1', { score: 2.5 })).rejects.toThrow(
      /between 1 and 5/
    );
    const { service: fresh, cases: freshCases } = build();
    await seedQueuedCase({ cases: freshCases });
    await expect(
      fresh.scoreQuality(supervisor, 'ecase-1', { score: 3 })
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SLA breacher sweep', () => {
  it('flags overdue queued/assigned cases exactly once and emits the breach event', async () => {
    const { service, cases, events } = build();
    await seedQueuedCase({ cases }, { slaDueAt: '2026-09-14T08:00:00.000Z' });
    const now = new Date('2026-09-14T09:00:00Z');
    const first = await service.sweep(now);
    expect(first.breached).toBe(1);
    const second = await service.sweep(now);
    expect(second.breached).toBe(0);
    const breaches = vi
      .mocked(events.publish)
      .mock.calls.filter(([name]) => name === 'voice.escalation.sla_breached');
    expect(breaches).toHaveLength(1);
    expect(breaches[0][1]).toMatchObject({ caseId: 'ecase-1', status: 'queued' });
  });

  it('does not flag cases still inside their SLA window', async () => {
    const { service, cases } = build();
    await seedQueuedCase({ cases }, { slaDueAt: '2026-09-15T08:00:00.000Z' });
    const result = await service.sweep(new Date('2026-09-14T09:00:00Z'));
    expect(result.breached).toBe(0);
  });

  it('retries failed deliveries; a recovered channel flips the case to answered', async () => {
    let attempts = 0;
    const { service, cases, events } = build(async () => {
      attempts += 1;
      return attempts === 1 ? stubFailed : delivered;
    });
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    await service.answerCase(agronomistA, 'ecase-1', { answerText: 'Scout weekly.' });
    const result = await service.sweep();
    expect(result.deliveryRetried).toBe(1);
    expect(result.deliveryRecovered).toBe(1);
    const record = await service.getCase(agronomistA, 'ecase-1');
    expect(record.status).toBe('answered');
    expect(record.deliveryAttempts).toBe(2);
    const answered = vi
      .mocked(events.publish)
      .mock.calls.filter(([name]) => name === 'voice.escalation.answered');
    expect(answered).toHaveLength(1);
    expect(answered[0][1]).toMatchObject({ caseId: 'ecase-1', recovered: true });
  });

  it('stops retrying past the attempt cap (honest exhaustion, never fabricated)', async () => {
    const { service, cases } = build(async () => stubFailed);
    await seedQueuedCase({ cases });
    await service.claimCase(agronomistA, 'ecase-1');
    for (let i = 0; i < 5; i++) {
      if (i === 0) {
        await service.answerCase(agronomistA, 'ecase-1', { answerText: 'Hold.' });
      } else {
        await service.sweep();
      }
    }
    const exhausted = await service.sweep();
    expect(exhausted.deliveryRetried).toBe(0);
    expect(exhausted.deliveryExhausted).toBe(1);
    const record = await service.getCase(agronomistA, 'ecase-1');
    expect(record.status).toBe('assigned');
    expect(record.deliveryStatus).toBe('failed');
  });
});

describe('SLA report (programme deliverable export)', () => {
  it('aggregates per-cohort status, breach and time-to-answer metrics', async () => {
    const { service, cases } = build();
    const created = new Date(Date.now() - 30 * 60_000).toISOString();
    await seedQueuedCase({ cases }, {
      id: 'ecase-open',
      agentCaseId: 'vcase-open',
      slaDueAt: new Date(Date.now() - 60_000).toISOString()
    });
    await seedQueuedCase({ cases }, {
      id: 'ecase-done',
      agentCaseId: 'vcase-done',
      cohort: 'wet-season-2026',
      createdAt: created
    });
    await service.claimCase(agronomistA, 'ecase-done');
    await service.answerCase(agronomistA, 'ecase-done', { answerText: 'ok' });
    await service.scoreQuality(admin, 'ecase-done', { score: 3 });

    const report = await service.slaReport(supervisor, 'wet-season-2026');
    expect(report.totals.cases).toBe(1);
    expect(report.totals.answered).toBe(1);
    expect(report.totals.breached).toBe(0);
    expect(report.timeToAnswerMinutes.samples).toBe(1);
    expect(report.timeToAnswerMinutes.average).toBeGreaterThan(0);
    expect(report.quality).toEqual({ samples: 1, averageScore: 3 });

    const all = await service.slaReport(supervisor);
    expect(all.totals.cases).toBe(2);
    expect(all.totals.breached).toBe(1);
    expect(all.totals.byStatus.queued).toBe(1);
    expect(all.totals.byStatus.answered).toBe(1);
  });
});
