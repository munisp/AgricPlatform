import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { LANGUAGE_CODES, type LanguageCode } from '@agric-platform/shared';
import type { Redis } from 'ioredis';
import { newId } from '../../common/async-repository.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_CASE_REPOSITORY,
  REDIS_CLIENT,
  VOICE_SESSION_REPOSITORY,
  VOICE_TURN_REPOSITORY
} from '../../database/persistence.tokens.js';
import {
  VOICE_CHANNELS,
  type AgentCaseRecord,
  type AgentCaseReason,
  type AgentCaseRepository,
  type AgentCaseStatus,
  type VoiceChannel,
  type VoiceSessionRecord,
  type VoiceSessionRepository,
  type VoiceTurnRecord,
  type VoiceTurnRepository
} from '../../database/repositories/voice.repository.js';
import { UsersService } from '../users/users.service.js';
import { AgronomyRagService } from './agronomy-rag.service.js';
import {
  createSpeechProvider,
  ProviderConfigError,
  ProviderHttpError,
  ProviderRequestError,
  type SpeechProvider
} from './speech.drivers.js';
import { createTtsDriver, type TtsDriver } from './tts.driver.js';
import {
  agronomyQueryFor,
  handleAgronomyUssdTurn,
  initialAgronomyUssdState,
  type UssdAgronomyState
} from './ussd-agronomy.js';
import {
  isTerminal,
  requestsHuman,
  signalsDone,
  transitionSession
} from './voice-session.js';
import { createVoiceMenuStateStore, type VoiceMenuStateStore } from './voice-menu-state.store.js';

/** Default SLA for a human-agent first response (env VOICE_CASE_SLA_HOURS). */
export const VOICE_CASE_SLA_HOURS_DEFAULT = 24;
/** ASR transcriptions below this confidence are not trusted for advice. */
export const ASR_MIN_CONFIDENCE = 0.35;
/** USSD menu-state TTL between callbacks. */
export const USSD_MENU_TTL_MS = 10 * 60 * 1000;

/** Safe fallback — never improvised agronomy. */
export const SAFE_FALLBACK_REPLY =
  'I cannot answer that confidently from our advisory library. ' +
  'I am connecting you to an agronomist who will follow up shortly.';

export interface StartVoiceSessionInput {
  channel: VoiceChannel;
  phone: string;
  ninRef?: string;
  locale?: LanguageCode;
}

export interface VoiceTurnInput {
  /** Free-text utterance (typed channel or pre-transcribed IVR). */
  text?: string;
  /** Audio URL from the telephony provider (transcribed via the ASR port). */
  audioUrl?: string;
  /** Latest USSD input segment (ussd channel). */
  ussdInput?: string;
}

export interface VoiceReply {
  text: string;
  /** RAG grounding: chunk ids the answer cites (empty for menus/fallback). */
  citations: string[];
  confidence: number;
  /** True when the reply is the safe fallback, not agronomy advice. */
  fallback: boolean;
  /** Honest en-only note for captured non-en locales. */
  localeNote?: string;
  /** USSD/IVR screen or speech markup, channel-dependent. */
  screen?: string;
  ssml?: string;
  /** True when the channel interaction ends with this reply. */
  end: boolean;
  /** Set when this turn opened/updated an escalation case. */
  agentCaseId?: string;
}

const PHONE_PATTERN = /^\+?[0-9][0-9 -]{5,18}$/;

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for the voice agronomist');
  }
  return actor;
}

function isAgent(actor: User): boolean {
  return actor.roles.includes('agronomist') || actor.roles.includes('admin');
}

/**
 * Voice agronomist orchestration (wave VOICE). Owns the session state
 * machine, the RAG grounding contract (no answer without citations; no
 * answer at all below threshold — safe fallback + auto-escalation), the
 * ASR/TTS fail-closed driver mapping (503 when live providers are
 * configured but unreachable) and the agent-case escalation queue.
 */
@Injectable()
export class VoiceService {
  private speech?: SpeechProvider;
  private tts?: TtsDriver;
  private readonly menuStore: VoiceMenuStateStore;

  constructor(
    private readonly users: UsersService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditService,
    @Inject(VOICE_SESSION_REPOSITORY) private readonly sessions: VoiceSessionRepository,
    @Inject(VOICE_TURN_REPOSITORY) private readonly turns: VoiceTurnRepository,
    @Inject(AGENT_CASE_REPOSITORY) private readonly cases: AgentCaseRepository,
    private readonly rag: AgronomyRagService,
    @Optional() @Inject(REDIS_CLIENT) redis: Redis | null = null,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.menuStore = createVoiceMenuStateStore(redis);
  }

  private resolveSpeech(): SpeechProvider {
    if (!this.speech) {
      try {
        this.speech = createSpeechProvider(this.env);
      } catch (error) {
        if (error instanceof ProviderConfigError) {
          throw new ServiceUnavailableException(
            `Voice agronomist ASR is not configured: ${error.message}`
          );
        }
        throw error;
      }
    }
    return this.speech;
  }

  private resolveTts(): TtsDriver {
    if (!this.tts) {
      try {
        this.tts = createTtsDriver(this.env);
      } catch (error) {
        if (error instanceof ProviderConfigError) {
          throw new ServiceUnavailableException(
            `Voice agronomist TTS is not configured: ${error.message}`
          );
        }
        throw error;
      }
    }
    return this.tts;
  }

  /** Visible for tests: reset lazily-built drivers after env changes. */
  resetDriversForTests(): void {
    this.speech = undefined;
    this.tts = undefined;
  }

  private slaHours(): number {
    const raw = Number(this.env.VOICE_CASE_SLA_HOURS);
    return Number.isFinite(raw) && raw > 0 ? raw : VOICE_CASE_SLA_HOURS_DEFAULT;
  }

  // -- Sessions ---------------------------------------------------------------

  async startSession(
    actor: User | null,
    input: StartVoiceSessionInput
  ): Promise<{ session: VoiceSessionRecord; openingScreen?: string }> {
    const caller = requireUser(actor);
    if (!VOICE_CHANNELS.includes(input.channel)) {
      throw new BadRequestException(
        `channel must be one of: ${VOICE_CHANNELS.join(', ')}`
      );
    }
    if (!input.phone || !PHONE_PATTERN.test(input.phone.trim())) {
      throw new BadRequestException('phone must be a valid MSISDN (e.g. +2348012345678)');
    }
    const locale = input.locale ?? 'en';
    if (!LANGUAGE_CODES.includes(locale)) {
      throw new BadRequestException(`locale must be one of: ${LANGUAGE_CODES.join(', ')}`);
    }

    // Farmer identity: the existing farmer directory (users by phone). An
    // unknown phone still gets a session — USSD/IVR callers are often
    // unregistered — but farmerUserId stays unset (honest identity).
    const known = await this.users.findByPhone(input.phone.trim());
    const now = new Date().toISOString();
    const session: VoiceSessionRecord = {
      id: newId('vsession'),
      channel: input.channel,
      state: 'intake',
      phone: input.phone.trim(),
      ...(input.ninRef ? { ninRef: input.ninRef.trim() } : {}),
      ...(known ? { farmerUserId: known.id } : {}),
      locale,
      menuState: input.channel === 'ussd' ? { ...initialAgronomyUssdState() } : {},
      createdAt: now,
      updatedAt: now
    };
    const created = await this.sessions.create(session);
    await this.events.publish(
      'voice.session.started',
      { sessionId: created.id, channel: created.channel, locale: created.locale },
      caller.id
    );
    await this.audit.record({
      actorId: caller.id,
      action: 'voice.session_started',
      entityType: 'voice_session',
      entityId: created.id,
      metadata: { channel: created.channel, identified: Boolean(known) }
    });

    if (created.channel === 'ussd') {
      const menu = initialAgronomyUssdState();
      await this.menuStore.set(created.id, menu, USSD_MENU_TTL_MS);
      const turn = handleAgronomyUssdTurn(menu, '');
      return { session: created, openingScreen: turn.response };
    }
    return { session: created };
  }

  // -- Turns -------------------------------------------------------------------

  async handleTurn(
    actor: User | null,
    sessionId: string,
    input: VoiceTurnInput
  ): Promise<{ session: VoiceSessionRecord; reply: VoiceReply }> {
    const caller = requireUser(actor);
    const session = await this.sessions.getById(sessionId);
    this.assertSessionAccess(caller, session);
    if (isTerminal(session.state)) {
      throw new ConflictException(`Voice session ${session.id} is resolved and accepts no turns`);
    }
    if (session.channel === 'ussd') {
      return this.handleUssdTurn(caller, session, input);
    }
    return this.handleFreeTextTurn(caller, session, input);
  }

  private assertSessionAccess(actor: User, session: VoiceSessionRecord): void {
    if (isAgent(actor)) {
      return;
    }
    if (session.farmerUserId && session.farmerUserId !== actor.id) {
      throw new ForbiddenException('This voice session belongs to another farmer');
    }
  }

  private async recordTurn(
    sessionId: string,
    speaker: VoiceTurnRecord['speaker'],
    text: string,
    extra: { citedChunkIds?: string[]; confidence?: number } = {}
  ): Promise<VoiceTurnRecord> {
    const turn: VoiceTurnRecord = {
      id: newId('vturn'),
      sessionId,
      turnIndex: await this.turns.nextIndex(sessionId),
      speaker,
      text,
      citedChunkIds: extra.citedChunkIds ?? [],
      ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
      createdAt: new Date().toISOString()
    };
    return this.turns.create(turn);
  }

  private async saveSession(session: VoiceSessionRecord): Promise<VoiceSessionRecord> {
    return this.sessions.update(session.id, { ...session, updatedAt: new Date().toISOString() });
  }

  /** Free-text flow for the IVR and ASSISTED channels. */
  private async handleFreeTextTurn(
    caller: User,
    session: VoiceSessionRecord,
    input: VoiceTurnInput
  ): Promise<{ session: VoiceSessionRecord; reply: VoiceReply }> {
    // 1) Obtain the utterance text — typed input directly, audio via the
    //    fail-closed ASR port.
    let text = input.text?.trim() ?? '';
    let asrConfidence = 1;
    if (!text && input.audioUrl) {
      const speech = this.resolveSpeech();
      try {
        const transcription = await speech.transcribe({
          audioUrl: input.audioUrl,
          locale: session.locale
        });
        text = transcription.text;
        asrConfidence = transcription.confidence;
      } catch (error) {
        if (
          error instanceof ProviderConfigError ||
          error instanceof ProviderRequestError ||
          error instanceof ProviderHttpError
        ) {
          throw new ServiceUnavailableException(
            'Speech transcription is unavailable: the ASR provider could not be reached. ' +
              'Try again later or use text input.'
          );
        }
        throw error;
      }
    }
    if (!text) {
      throw new BadRequestException('Provide text or an audioUrl for the turn');
    }
    await this.recordTurn(session.id, 'farmer', text, { confidence: asrConfidence });

    // 2) Unusable transcription → safe fallback + escalation, never a guess.
    if (asrConfidence < ASR_MIN_CONFIDENCE) {
      const result = await this.escalateInternal(caller, session, 'low_confidence', {
        note: `ASR confidence ${asrConfidence} below ${ASR_MIN_CONFIDENCE}`
      });
      const reply = await this.decorateReply(session, {
        text: 'I could not hear that clearly. I am connecting you to an agronomist who will follow up shortly.',
        citations: [],
        confidence: asrConfidence,
        fallback: true,
        end: false,
        agentCaseId: result.caseRecord.id
      });
      await this.recordTurn(result.session.id, 'assistant', reply.text);
      return { session: result.session, reply };
    }

    // 3) Explicit human request works from any non-terminal state.
    if (requestsHuman(text)) {
      const result = await this.escalateInternal(caller, session, 'requested', {});
      const reply = await this.decorateReply(session, {
        text: 'I am connecting you to an agronomist. You will receive a follow-up shortly.',
        citations: [],
        confidence: 1,
        fallback: true,
        end: false,
        agentCaseId: result.caseRecord.id
      });
      await this.recordTurn(result.session.id, 'assistant', reply.text);
      return { session: result.session, reply };
    }

    // 4) Polite close from advisory → resolved.
    if (session.state === 'advisory' && signalsDone(text)) {
      const resolved = transitionSession(session, 'resolved');
      const saved = await this.saveSession(resolved);
      await this.events.publish('voice.session.resolved', { sessionId: saved.id }, caller.id);
      const reply = await this.decorateReply(saved, {
        text: 'Glad I could help. Wishing you a good season!',
        citations: [],
        confidence: 1,
        fallback: false,
        end: true
      });
      await this.recordTurn(saved.id, 'assistant', reply.text);
      return { session: saved, reply };
    }

    // 5) INTAKE: capture crop context, advance to TRIAGE, ask the question.
    if (session.state === 'intake') {
      const crop = this.detectCrop(text);
      const triaged = transitionSession(
        { ...session, ...(crop ? { crop } : {}) },
        'triage'
      );
      const saved = await this.saveSession(triaged);
      const reply = await this.decorateReply(saved, {
        text: crop
          ? `Understood — ${crop}. Please describe the problem you are seeing (for example: pests, disease, soil, water, or planting).`
          : 'Welcome to the voice agronomist. Which crop is this about, and what problem are you seeing?',
        citations: [],
        confidence: 1,
        fallback: false,
        end: false
      });
      await this.recordTurn(saved.id, 'assistant', reply.text);
      return { session: saved, reply };
    }

    // 6) TRIAGE/ADVISORY: grounded RAG answer or safe fallback + escalation.
    const query = session.crop ? `${session.crop} ${text}` : text;
    const answer = await this.rag.answer(query, {
      locale: session.locale as LanguageCode,
      crop: session.crop
    });
    if (answer.status === 'answered') {
      const advanced =
        session.state === 'triage' ? transitionSession(session, 'advisory') : session;
      const saved = await this.saveSession(advanced);
      const reply = await this.decorateReply(saved, {
        text: answer.answer,
        citations: answer.citations,
        confidence: answer.confidence,
        fallback: false,
        end: false,
        ...(answer.localeNote ? { localeNote: answer.localeNote } : {})
      });
      await this.recordTurn(saved.id, 'assistant', reply.text, {
        citedChunkIds: answer.citations,
        confidence: answer.confidence
      });
      return { session: saved, reply };
    }

    const reason: AgentCaseReason = answer.status === 'no_grounding' ? 'no_grounding' : 'low_confidence';
    const result = await this.escalateInternal(caller, session, reason, {
      suggestedAnswer: answer.suggestedAnswer
    });
    const reply = await this.decorateReply(result.session, {
      text: SAFE_FALLBACK_REPLY,
      citations: [],
      confidence: answer.confidence,
      fallback: true,
      end: false,
      agentCaseId: result.caseRecord.id,
      ...(answer.localeNote ? { localeNote: answer.localeNote } : {})
    });
    await this.recordTurn(result.session.id, 'assistant', reply.text, {
      confidence: answer.confidence
    });
    return { session: result.session, reply };
  }

  /** USSD flow: pure menu engine + RAG effect execution. */
  private async handleUssdTurn(
    caller: User,
    session: VoiceSessionRecord,
    input: VoiceTurnInput
  ): Promise<{ session: VoiceSessionRecord; reply: VoiceReply }> {
    const rawInput = input.ussdInput ?? input.text ?? '';
    const persisted = session.menuState as Partial<UssdAgronomyState> | undefined;
    const menuState =
      (await this.menuStore.get(session.id)) ??
      (persisted && persisted.menu ? (persisted as UssdAgronomyState) : initialAgronomyUssdState());
    const turn = handleAgronomyUssdTurn(menuState, rawInput);
    await this.recordTurn(session.id, 'farmer', rawInput === '' ? '(session open)' : rawInput);

    if (turn.effect?.type === 'escalate') {
      const result = await this.escalateInternal(caller, session, 'requested', {});
      await this.menuStore.delete(session.id);
      const reply: VoiceReply = {
        text: turn.response,
        citations: [],
        confidence: 1,
        fallback: true,
        screen: turn.response,
        end: true,
        agentCaseId: result.caseRecord.id
      };
      await this.recordTurn(result.session.id, 'assistant', turn.response);
      return { session: result.session, reply };
    }

    if (turn.effect?.type === 'agronomy_query') {
      const effect = turn.effect;
      const answer = await this.rag.answer(agronomyQueryFor(effect.crop, effect.categoryLabel), {
        locale: session.locale as LanguageCode,
        crop: effect.crop
      });
      const withContext = await this.saveSession({
        ...session,
        crop: effect.crop,
        symptomCategory: effect.category,
        menuState: { ...turn.state }
      });
      await this.menuStore.delete(session.id);
      if (answer.status === 'answered') {
        // USSD menus compress intake + triage into the menu navigation; walk
        // the state machine through triage before reaching advisory.
        const progressed =
          withContext.state === 'intake'
            ? transitionSession(withContext, 'triage')
            : withContext;
        const saved = await this.saveSession(transitionSession(progressed, 'advisory'));
        const screen = this.ussdAnswerScreen(answer.answer);
        await this.recordTurn(saved.id, 'assistant', answer.answer, {
          citedChunkIds: answer.citations,
          confidence: answer.confidence
        });
        return {
          session: saved,
          reply: {
            text: answer.answer,
            citations: answer.citations,
            confidence: answer.confidence,
            fallback: false,
            screen,
            end: true,
            ...(answer.localeNote ? { localeNote: answer.localeNote } : {})
          }
        };
      }
      const reason: AgentCaseReason =
        answer.status === 'no_grounding' ? 'no_grounding' : 'low_confidence';
      const result = await this.escalateInternal(caller, withContext, reason, {
        suggestedAnswer: answer.suggestedAnswer
      });
      const screen = `END ${SAFE_FALLBACK_REPLY}`.slice(0, 182);
      await this.recordTurn(result.session.id, 'assistant', SAFE_FALLBACK_REPLY, {
        confidence: answer.confidence
      });
      return {
        session: result.session,
        reply: {
          text: SAFE_FALLBACK_REPLY,
          citations: [],
          confidence: answer.confidence,
          fallback: true,
          screen,
          end: true,
          agentCaseId: result.caseRecord.id,
          ...(answer.localeNote ? { localeNote: answer.localeNote } : {})
        }
      };
    }

    // Plain menu navigation: persist the new menu state.
    const saved = await this.saveSession({ ...session, menuState: { ...turn.state } });
    await this.menuStore.set(saved.id, turn.state, USSD_MENU_TTL_MS);
    await this.recordTurn(saved.id, 'assistant', turn.response);
    return {
      session: saved,
      reply: {
        text: turn.response,
        citations: [],
        confidence: 1,
        fallback: false,
        screen: turn.response,
        end: turn.end
      }
    };
  }

  /** Caps a grounded answer to one USSD END screen. */
  private ussdAnswerScreen(answer: string): string {
    const body = answer.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    return `END ${body}`.slice(0, 182);
  }

  /** Adds the TTS speech markup for the IVR channel (fail-closed live TTS). */
  private async decorateReply(
    session: VoiceSessionRecord,
    reply: VoiceReply
  ): Promise<VoiceReply> {
    if (session.channel !== 'ivr') {
      return reply;
    }
    const tts = this.resolveTts();
    try {
      const speech = await tts.synthesize({ text: reply.text, locale: session.locale });
      return { ...reply, ssml: speech.ssml };
    } catch (error) {
      if (
        error instanceof ProviderConfigError ||
        error instanceof ProviderRequestError ||
        error instanceof ProviderHttpError
      ) {
        throw new ServiceUnavailableException(
          'Speech synthesis is unavailable: the TTS provider could not be reached. Try again later.'
        );
      }
      throw error;
    }
  }

  /** Best-effort crop capture from free text (deterministic keyword match). */
  private detectCrop(text: string): string | undefined {
    const lower = text.toLowerCase();
    const known = ['maize', 'cassava', 'rice', 'yam', 'sorghum', 'cowpea', 'millet', 'soybean', 'groundnut'];
    return known.find((crop) => lower.includes(crop));
  }

  // -- Escalation ---------------------------------------------------------------

  /** Idempotent escalation: an open case for the session is returned as-is. */
  private async escalateInternal(
    caller: User,
    session: VoiceSessionRecord,
    reason: AgentCaseReason,
    extra: { suggestedAnswer?: string; note?: string }
  ): Promise<{ session: VoiceSessionRecord; caseRecord: AgentCaseRecord }> {
    if (session.activeCaseId) {
      const existing = await this.cases.findById(session.activeCaseId);
      if (existing && existing.status !== 'resolved') {
        return { session, caseRecord: existing };
      }
    }
    const now = new Date();
    const caseRecord: AgentCaseRecord = {
      id: newId('vcase'),
      sessionId: session.id,
      ...(session.farmerUserId ? { farmerUserId: session.farmerUserId } : {}),
      phone: session.phone,
      channel: session.channel,
      status: 'open',
      reason,
      priority: reason === 'no_grounding' ? 'high' : 'normal',
      slaDueAt: new Date(now.getTime() + this.slaHours() * 3_600_000).toISOString(),
      ...(extra.suggestedAnswer ? { suggestedAnswer: extra.suggestedAnswer } : {}),
      citationChunkIds: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const created = await this.cases.create(caseRecord);
    const escalated = transitionSession({ ...session, activeCaseId: created.id }, 'escalated');
    const saved = await this.saveSession(escalated);
    await this.events.publish(
      'voice.agent_case.created',
      {
        caseId: created.id,
        sessionId: session.id,
        reason,
        priority: created.priority,
        slaDueAt: created.slaDueAt
      },
      caller.id
    );
    await this.events.publish(
      'voice.session.escalated',
      { sessionId: session.id, caseId: created.id, reason },
      caller.id
    );
    await this.audit.record({
      actorId: caller.id,
      action: 'voice.session_escalated',
      entityType: 'agent_case',
      entityId: created.id,
      metadata: { sessionId: session.id, reason, ...(extra.note ? { note: extra.note } : {}) }
    });
    return { session: saved, caseRecord: created };
  }

  /** Manual escalation endpoint (farmer or agent). */
  async escalate(
    actor: User | null,
    sessionId: string,
    reason: AgentCaseReason = 'requested'
  ): Promise<{ session: VoiceSessionRecord; agentCase: AgentCaseRecord }> {
    const caller = requireUser(actor);
    const session = await this.sessions.getById(sessionId);
    this.assertSessionAccess(caller, session);
    if (isTerminal(session.state)) {
      throw new ConflictException(`Voice session ${session.id} is already resolved`);
    }
    const result = await this.escalateInternal(caller, session, reason, {});
    return { session: result.session, agentCase: result.caseRecord };
  }

  // -- Agent queue ----------------------------------------------------------------

  async listAgentCases(
    actor: User | null,
    filter: { status?: AgentCaseStatus; overdueOnly?: boolean } = {}
  ): Promise<AgentCaseRecord[]> {
    const caller = requireUser(actor);
    if (!isAgent(caller)) {
      throw new ForbiddenException('Agent queue requires the agronomist or admin role');
    }
    return this.cases.find({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.overdueOnly ? { slaDueAtOrBefore: new Date().toISOString() } : {})
    });
  }

  async getAgentCase(
    actor: User | null,
    caseId: string
  ): Promise<{
    agentCase: AgentCaseRecord;
    session: VoiceSessionRecord;
    turns: VoiceTurnRecord[];
  }> {
    const caller = requireUser(actor);
    if (!isAgent(caller)) {
      throw new ForbiddenException('Agent cases require the agronomist or admin role');
    }
    const agentCase = await this.cases.getById(caseId);
    const session = await this.sessions.getById(agentCase.sessionId);
    const turns = await this.turns.listForSession(session.id);
    return { agentCase, session, turns };
  }

  /** Agent first response; optionally resolves the case + session. */
  async respondToCase(
    actor: User | null,
    caseId: string,
    input: { response: string; resolve?: boolean }
  ): Promise<{ agentCase: AgentCaseRecord; session: VoiceSessionRecord }> {
    const caller = requireUser(actor);
    if (!isAgent(caller)) {
      throw new ForbiddenException('Agent cases require the agronomist or admin role');
    }
    if (!input.response || input.response.trim().length === 0) {
      throw new BadRequestException('response must not be empty');
    }
    const agentCase = await this.cases.getById(caseId);
    if (agentCase.status === 'resolved') {
      throw new ConflictException(`Agent case ${caseId} is already resolved`);
    }
    const now = new Date().toISOString();
    const updated = await this.cases.update(caseId, {
      status: input.resolve ? 'resolved' : 'responded',
      response: input.response.trim(),
      respondedAt: now,
      assignedAgentId: agentCase.assignedAgentId ?? caller.id,
      updatedAt: now
    });
    const session = await this.sessions.getById(agentCase.sessionId);
    await this.recordTurn(session.id, 'agent', input.response.trim());

    let savedSession = session;
    if (input.resolve && session.state === 'escalated') {
      savedSession = await this.saveSession(transitionSession(session, 'resolved'));
      await this.events.publish(
        'voice.session.resolved',
        { sessionId: session.id, caseId },
        caller.id
      );
    }
    await this.events.publish(
      'voice.agent_case.responded',
      { caseId, sessionId: session.id, resolved: input.resolve === true },
      caller.id
    );
    await this.audit.record({
      actorId: caller.id,
      action: 'voice.agent_case_responded',
      entityType: 'agent_case',
      entityId: caseId,
      metadata: { resolved: input.resolve === true }
    });
    return { agentCase: updated, session: savedSession };
  }

  /** Session transcript (owner or agent). */
  async getSessionTranscript(
    actor: User | null,
    sessionId: string
  ): Promise<{ session: VoiceSessionRecord; turns: VoiceTurnRecord[] }> {
    const caller = requireUser(actor);
    const session = await this.sessions.getById(sessionId);
    this.assertSessionAccess(caller, session);
    return { session, turns: await this.turns.listForSession(session.id) };
  }
}
