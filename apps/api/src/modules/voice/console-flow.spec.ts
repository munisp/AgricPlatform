import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryOutboxRepository } from '../../database/repositories/outbox.repository.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import { createInMemoryEscalationCaseRepository } from '../../database/repositories/escalation-console.repository.js';
import {
  createInMemoryAgentCaseRepository,
  createInMemoryVoiceSessionRepository,
  createInMemoryVoiceTurnRepository
} from '../../database/repositories/voice.repository.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { UsersService } from '../users/users.service.js';
import { AgronomyRagService, type AgronomyCorpus } from './agronomy-rag.service.js';
import { EscalationConsoleService } from './escalation-console.service.js';
import { VoiceService } from './voice.service.js';

/**
 * Console flow integration (Stage 27 innovation #19): a real voice session
 * whose retrieval has no grounding auto-escalates; the escalation event
 * lands on the agronomist console queue through the real
 * DomainEventsService outbox fan-out; the agronomist claims and answers;
 * the stub SMS driver returns its HONEST delivered:false, so the answer is
 * recorded but the case is never marked answered-to-farmer.
 */
const farmer = { id: 'farmer-flow-1', roles: ['farmer'], phone: '+2348011111111' } as User;
const agronomist = { id: 'agronomist-flow-1', roles: ['agronomist'] } as User;

async function flushIntake(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function build() {
  const users = new UsersService(createInMemoryUserRepository());
  const outbox = createInMemoryOutboxRepository();
  const events = new DomainEventsService(outbox);
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const sessions = createInMemoryVoiceSessionRepository();
  const turns = createInMemoryVoiceTurnRepository();
  const agentCases = createInMemoryAgentCaseRepository();
  // An empty corpus guarantees the safe fallback + auto-escalation path.
  const corpus: AgronomyCorpus = { listChunks: async () => [] };
  const rag = new AgronomyRagService(corpus);
  const voice = new VoiceService(
    users,
    events,
    audit,
    sessions,
    turns,
    agentCases,
    rag,
    null,
    {} as NodeJS.ProcessEnv
  );
  const consoleCases = createInMemoryEscalationCaseRepository();
  // Real IntegrationsService with default (stub) SMS adapter: the honest
  // delivered:false path, no fabricated delivery.
  const integrations = new IntegrationsService();
  const console_ = new EscalationConsoleService(
    consoleCases,
    agentCases,
    sessions,
    events,
    audit,
    integrations,
    undefined,
    { AGRONOMIST_SLA_BUSINESS_HOURS: '4' } as NodeJS.ProcessEnv
  );
  console_.onModuleInit();
  return { voice, console_, consoleCases, outbox };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice escalation → console queue → honest answer delivery', () => {
  it('low-confidence session surfaces on the console queue; stub SMS keeps the case honestly assigned', async () => {
    const { voice, console_, consoleCases, outbox } = build();

    // 1) Farmer session: intake (crop) → triage question with no grounding.
    const { session } = await voice.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348011111111'
    });
    await voice.handleTurn(farmer, session.id, { text: 'maize' });
    const turn = await voice.handleTurn(farmer, session.id, {
      text: 'strange purple dust on the leaves after the rain'
    });
    expect(turn.reply.fallback).toBe(true);
    expect(turn.reply.agentCaseId).toBeTruthy();
    expect(turn.session.state).toBe('escalated');

    // 2) The escalation event mirrors onto the console queue (async intake).
    await flushIntake();
    const queued = await console_.listCases(agronomist, { status: 'queued' });
    expect(queued).toHaveLength(1);
    const consoleCase = queued[0];
    expect(consoleCase.agentCaseId).toBe(turn.reply.agentCaseId);
    expect(consoleCase.phone).toBe('+2348011111111');
    expect(consoleCase.status).toBe('queued');
    // Business-hours SLA: 4 business hours after enqueue, inside the window.
    expect(consoleCase.slaDueAt > consoleCase.createdAt).toBe(true);

    // 3) Agronomist claims (CAS) and answers; the stub SMS driver reports
    //    delivered:false, so the case stays assigned with delivery failed.
    await console_.claimCase(agronomist, consoleCase.id);
    const answer = await console_.answerCase(agronomist, consoleCase.id, {
      answerText: 'That sounds like a fungal bloom after rain; scout and photograph before spraying.'
    });
    expect(answer.delivery.delivered).toBe(false);
    expect(answer.delivery.driver).toBe('stub');
    expect(answer.escalationCase.status).toBe('assigned');
    expect(answer.escalationCase.deliveryStatus).toBe('failed');
    expect(answer.escalationCase.answerText).toContain('fungal bloom');

    // 4) Honesty audit of the outbox: escalation + claim events exist, and
    //    NO voice.escalation.answered was ever published (the farmer's
    //    channel did not confirm).
    const records = await outbox.listRecords();
    const names = records.map((record) => record.event.name);
    expect(names).toContain('voice.agent_case.created');
    expect(names).toContain('voice.escalation.claimed');
    expect(names).not.toContain('voice.escalation.answered');

    // 5) The queue reflects the still-open work (assigned, not answered).
    const remaining = await console_.listCases(agronomist, { status: 'assigned' });
    expect(remaining.map((record) => record.id)).toEqual([consoleCase.id]);
    expect(await consoleCases.findByAgentCaseId(turn.reply.agentCaseId!)).toBeTruthy();
  });

  it('console intake is idempotent for a replayed escalation event', async () => {
    const { voice, console_ } = build();
    const { session } = await voice.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348011111111'
    });
    await voice.handleTurn(farmer, session.id, { text: 'maize' });
    const turn = await voice.handleTurn(farmer, session.id, { text: 'unanswerable question' });
    await flushIntake();
    // Direct re-enqueue (event replay) returns the same console case.
    const first = (await console_.listCases(agronomist, { status: 'queued' }))[0];
    const replayed = await console_.enqueueFromAgentCase(turn.reply.agentCaseId!);
    expect(replayed.id).toBe(first.id);
    expect(await console_.listCases(agronomist, { status: 'queued' })).toHaveLength(1);
  });
});
