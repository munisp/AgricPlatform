import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@agric-platform/shared';
import type { AuditService } from '../../core/audit.service.js';
import type { DomainEventsService } from '../../core/domain-events.service.js';
import { createInMemoryUserRepository } from '../../database/repositories/user.repository.js';
import {
  createInMemoryAgentCaseRepository,
  createInMemoryVoiceSessionRepository,
  createInMemoryVoiceTurnRepository
} from '../../database/repositories/voice.repository.js';
import { UsersService } from '../users/users.service.js';
import { AgronomyRagService, type AgronomyCorpus, type CorpusChunk } from './agronomy-rag.service.js';
import { SAFE_FALLBACK_REPLY, VoiceService } from './voice.service.js';

const CORPUS: CorpusChunk[] = [
  {
    id: 'advisory:adv-fall-armyworm:0',
    source: 'advisory',
    title: 'Fall armyworm watch',
    text: 'Fall armyworm watch. Inspect maize early-morning whorl damage and scout fields twice weekly.',
    crop: 'Maize',
    tags: ['pest_alert', 'Maize']
  },
  {
    id: 'advisory:adv-maize-calendar:0',
    source: 'advisory',
    title: 'Maize planting window',
    text: 'Maize planting window. Prepare land, confirm seed quality, and align planting with forecast rainfall onset.',
    crop: 'Maize',
    tags: ['crop_calendar', 'Maize']
  }
];

const farmer = { id: 'user-farmer-1', roles: ['farmer'], phone: '+2348011111111' } as User;
const otherFarmer = { id: 'user-farmer-2', roles: ['farmer'], phone: '+2348022222222' } as User;
const agent = { id: 'user-agent-1', roles: ['agronomist'], phone: '+2348099999999' } as User;

function build(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv) {
  const users = new UsersService(createInMemoryUserRepository());
  const events = { publish: vi.fn().mockResolvedValue({}) } as unknown as DomainEventsService;
  const audit = { record: vi.fn().mockResolvedValue({}) } as unknown as AuditService;
  const sessions = createInMemoryVoiceSessionRepository();
  const turns = createInMemoryVoiceTurnRepository();
  const cases = createInMemoryAgentCaseRepository();
  const corpus: AgronomyCorpus = { listChunks: async () => CORPUS };
  const rag = new AgronomyRagService(corpus);
  const service = new VoiceService(users, events, audit, sessions, turns, cases, rag, null, env);
  return { service, users, events, audit, sessions, turns, cases };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VoiceService.startSession', () => {
  it('requires authentication', async () => {
    const { service } = build();
    await expect(
      service.startSession(null, { channel: 'ivr', phone: '+2348012345678' })
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('validates channel, phone and locale', async () => {
    const { service } = build();
    await expect(
      service.startSession(farmer, { channel: 'smoke-signal' as never, phone: '+2348012345678' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.startSession(farmer, { channel: 'ivr', phone: 'abc' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.startSession(farmer, { channel: 'ivr', phone: '+2348012345678', locale: 'fr' as never })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('links farmer identity via the phone directory and stores the optional NIN ref', async () => {
    const { service, users } = build();
    const registered = await users.create({
      phone: '+2348033333333',
      fullName: 'Adaeze Voice',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348033333333',
      ninRef: 'NIN-1234'
    });
    expect(session.farmerUserId).toBe(registered.id);
    expect(session.ninRef).toBe('NIN-1234');
    expect(session.state).toBe('intake');
  });

  it('unknown phone still opens a session (unidentified caller, honestly unlinked)', async () => {
    const { service } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'ussd',
      phone: '+2348077777777'
    });
    expect(session.farmerUserId).toBeUndefined();
  });

  it('ussd channel returns the opening crop menu screen', async () => {
    const { service } = build();
    const { openingScreen } = await service.startSession(farmer, {
      channel: 'ussd',
      phone: '+2348012345678'
    });
    expect(openingScreen).toMatch(/^CON /);
    expect(openingScreen).toContain('Maize');
  });
});

describe('VoiceService.handleTurn — free-text flow', () => {
  it('walks intake → triage → advisory with a grounded, cited answer', async () => {
    const { service, turns } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348012345678'
    });
    const intake = await service.handleTurn(farmer, session.id, { text: 'It is about my maize field' });
    expect(intake.session.state).toBe('triage');
    expect(intake.session.crop).toBe('maize');

    const triage = await service.handleTurn(farmer, session.id, {
      text: 'fall armyworm damage in the whorl'
    });
    expect(triage.session.state).toBe('advisory');
    expect(triage.reply.fallback).toBe(false);
    expect(triage.reply.citations).toContain('advisory:adv-fall-armyworm:0');
    const transcript = await turns.listForSession(session.id);
    const assistantTurns = transcript.filter((t) => t.speaker === 'assistant');
    expect(assistantTurns.at(-1)?.citedChunkIds).toEqual(triage.reply.citations);
  });

  it('no grounding → safe fallback + automatic escalation (never improvised agronomy)', async () => {
    const { service, cases, events, turns } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348012345678'
    });
    await service.handleTurn(farmer, session.id, { text: 'hello there' });
    const result = await service.handleTurn(farmer, session.id, {
      text: 'quantum blockchain satellite insurance'
    });
    expect(result.session.state).toBe('escalated');
    expect(result.reply.text).toBe(SAFE_FALLBACK_REPLY);
    expect(result.reply.citations).toEqual([]);
    expect(result.reply.agentCaseId).toBeDefined();
    const open = await cases.find({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].reason).toBe('no_grounding');
    expect(open[0].priority).toBe('high');
    expect(open[0].slaDueAt > new Date().toISOString()).toBe(true);
    // Fallback assistant turn cites nothing — it is not advice.
    const transcript = await turns.listForSession(session.id);
    expect(transcript.at(-1)?.citedChunkIds).toEqual([]);
    expect(events.publish).toHaveBeenCalledWith(
      'voice.agent_case.created',
      expect.objectContaining({ caseId: open[0].id, reason: 'no_grounding' }),
      farmer.id
    );
  });

  it('low-confidence ASR transcription escalates instead of guessing', async () => {
    const { service, cases } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348012345678'
    });
    // Stub ASR: audio-only input yields a simulated 0.2-confidence transcript.
    const result = await service.handleTurn(farmer, session.id, {
      audioUrl: 'https://calls.example/rec-9.mp3'
    });
    expect(result.session.state).toBe('escalated');
    const open = await cases.find({ status: 'open' });
    expect(open[0]?.reason).toBe('low_confidence');
  });

  it('explicit human request escalates from any state', async () => {
    const { service, cases } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348012345678'
    });
    const result = await service.handleTurn(farmer, session.id, {
      text: 'please connect me to an agent'
    });
    expect(result.session.state).toBe('escalated');
    const open = await cases.find({ status: 'open' });
    expect(open[0]?.reason).toBe('requested');
  });

  it('thanks in advisory resolves the session; further turns are rejected with 409', async () => {
    const { service } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348012345678'
    });
    await service.handleTurn(farmer, session.id, { text: 'maize' });
    await service.handleTurn(farmer, session.id, { text: 'fall armyworm damage' });
    const done = await service.handleTurn(farmer, session.id, { text: 'thanks, done' });
    expect(done.session.state).toBe('resolved');
    await expect(
      service.handleTurn(farmer, session.id, { text: 'one more thing' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('ivr replies carry TTS SSML (stub driver)', async () => {
    const { service } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348012345678'
    });
    const result = await service.handleTurn(farmer, session.id, { text: 'maize pests' });
    expect(result.reply.ssml).toMatch(/^<speak/);
  });

  it('forbids another farmer from driving the session', async () => {
    const { service, users } = build();
    const registered = await users.create({
      phone: '+2348044444444',
      fullName: 'Owner Farmer',
      roles: ['farmer'],
      preferredLanguage: 'en'
    });
    const { session } = await service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348044444444'
    });
    expect(session.farmerUserId).toBe(registered.id);
    await expect(
      service.handleTurn(otherFarmer, session.id, { text: 'maize' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('VoiceService — fail-closed live ASR/TTS', () => {
  it('ASR_DRIVER=http without ASR_PROVIDER_URL answers 503', async () => {
    const { service } = build({ ASR_DRIVER: 'http' } as NodeJS.ProcessEnv);
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348012345678'
    });
    await expect(
      service.handleTurn(farmer, session.id, { audioUrl: 'https://x/r.mp3' })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ASR configured but unreachable answers 503 (never silently stubs)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { service } = build({
      ASR_DRIVER: 'http',
      ASR_PROVIDER_URL: 'http://asr.local:9000'
    } as NodeJS.ProcessEnv);
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348012345678'
    });
    await expect(
      service.handleTurn(farmer, session.id, { audioUrl: 'https://x/r.mp3' })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('TTS configured but unreachable answers 503 on ivr replies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const { service } = build({
      TTS_DRIVER: 'http',
      TTS_PROVIDER_URL: 'http://tts.local:9001'
    } as NodeJS.ProcessEnv);
    const { session } = await service.startSession(farmer, {
      channel: 'ivr',
      phone: '+2348012345678'
    });
    await expect(
      service.handleTurn(farmer, session.id, { text: 'maize pests' })
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('VoiceService — USSD flow', () => {
  it('menu path crop → symptom → grounded answer screen', async () => {
    const { service } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'ussd',
      phone: '+2348012345678'
    });
    const crop = await service.handleTurn(farmer, session.id, { ussdInput: '1' });
    expect(crop.reply.screen).toContain('what is the problem');
    const answer = await service.handleTurn(farmer, session.id, { ussdInput: '1' });
    expect(answer.session.state).toBe('advisory');
    expect(answer.reply.citations.length).toBeGreaterThan(0);
    expect(answer.reply.screen).toMatch(/^END /);
    expect(answer.reply.screen!.length).toBeLessThanOrEqual(182);
  });

  it('menu key 9 escalates to an agent', async () => {
    const { service, cases } = build();
    const { session } = await service.startSession(farmer, {
      channel: 'ussd',
      phone: '+2348012345678'
    });
    const result = await service.handleTurn(farmer, session.id, { ussdInput: '9' });
    expect(result.session.state).toBe('escalated');
    expect((await cases.find({}))[0]?.reason).toBe('requested');
  });
});

describe('VoiceService — escalation + agent queue', () => {
  async function escalatedSession() {
    const ctx = build();
    const { session } = await ctx.service.startSession(farmer, {
      channel: 'assisted',
      phone: '+2348012345678'
    });
    const { agentCase } = await ctx.service.escalate(farmer, session.id);
    return { ...ctx, session, agentCase };
  }

  it('manual escalation is idempotent per session', async () => {
    const { service, session, agentCase } = await escalatedSession();
    const again = await service.escalate(farmer, session.id);
    expect(again.agentCase.id).toBe(agentCase.id);
  });

  it('farmers cannot read the agent queue; agronomists can', async () => {
    const { service } = await escalatedSession();
    await expect(service.listAgentCases(farmer)).rejects.toBeInstanceOf(ForbiddenException);
    const queue = await service.listAgentCases(agent, { status: 'open' });
    expect(queue).toHaveLength(1);
  });

  it('agent respond assigns, records a transcript turn and resolves case + session', async () => {
    const { service, session, agentCase, events, turns } = await escalatedSession();
    const { agentCase: updated, session: resolved } = await service.respondToCase(
      agent,
      agentCase.id,
      { response: 'Apply neem-based biopesticide at dawn; scout again in 3 days.', resolve: true }
    );
    expect(updated.status).toBe('resolved');
    expect(updated.assignedAgentId).toBe(agent.id);
    expect(updated.respondedAt).toBeDefined();
    expect(resolved.state).toBe('resolved');
    const transcript = await turns.listForSession(session.id);
    expect(transcript.at(-1)?.speaker).toBe('agent');
    expect(events.publish).toHaveBeenCalledWith(
      'voice.agent_case.responded',
      expect.objectContaining({ caseId: agentCase.id, resolved: true }),
      agent.id
    );
    await expect(
      service.respondToCase(agent, agentCase.id, { response: 'again' })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('respond requires a non-empty response and the agent role', async () => {
    const { service, agentCase } = await escalatedSession();
    await expect(
      service.respondToCase(agent, agentCase.id, { response: '  ' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.respondToCase(farmer, agentCase.id, { response: 'fake answer' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('escalation on a resolved session is rejected with 409', async () => {
    const { service, session, agentCase } = await escalatedSession();
    await service.respondToCase(agent, agentCase.id, { response: 'done', resolve: true });
    await expect(service.escalate(farmer, session.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
