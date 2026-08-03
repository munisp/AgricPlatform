import { ConflictException } from '@nestjs/common';
import type {
  VoiceSessionRecord,
  VoiceSessionState
} from '../../database/repositories/voice.repository.js';

/**
 * VoiceSession aggregate state machine (wave VOICE). Pure functions — the
 * service layer owns persistence and I/O. Lifecycle:
 *
 *   intake → triage → advisory → (escalated | resolved)
 *
 * intake:     channel opened, farmer identity + locale captured.
 * triage:     crop / symptom category being collected.
 * advisory:   grounded RAG answers are being served.
 * escalated:  an AgentCase is open; the farmer waits for a human.
 * resolved:   terminal — no further turns are accepted.
 *
 * Direct escalation from intake/triage is allowed (the farmer can always ask
 * for a human, and low-confidence retrieval auto-escalates without waiting
 * for the advisory state).
 */
const TRANSITIONS: Readonly<Record<VoiceSessionState, readonly VoiceSessionState[]>> = {
  intake: ['triage', 'escalated', 'resolved'],
  triage: ['advisory', 'escalated', 'resolved'],
  advisory: ['escalated', 'resolved'],
  escalated: ['resolved'],
  resolved: []
};

export function canTransition(from: VoiceSessionState, to: VoiceSessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** All legal targets for a state (kept for tests + docs). */
export function transitionsFor(state: VoiceSessionState): readonly VoiceSessionState[] {
  return TRANSITIONS[state];
}

/**
 * Advances the aggregate one state. Same-state is a no-op (returns the
 * record unchanged); an illegal jump raises ConflictException (409) so API
 * callers get an honest status code.
 */
export function transitionSession(
  session: VoiceSessionRecord,
  to: VoiceSessionState,
  updatedAt: string = new Date().toISOString()
): VoiceSessionRecord {
  if (to === session.state) {
    return session;
  }
  if (!canTransition(session.state, to)) {
    throw new ConflictException(
      `Voice session ${session.id} cannot transition from '${session.state}' to '${to}'`
    );
  }
  return { ...session, state: to, updatedAt };
}

/** Terminal states accept no further farmer turns. */
export function isTerminal(state: VoiceSessionState): boolean {
  return state === 'resolved';
}

/** Escalation keyword check for free-text turns (deterministic, en-only). */
const ESCALATION_PATTERN = /\b(agent|agronomist|human|escalate|operator|expert)\b/i;

export function requestsHuman(text: string): boolean {
  return ESCALATION_PATTERN.test(text);
}

/** Resolution keyword check for free-text turns (deterministic, en-only). */
const RESOLUTION_PATTERN = /\b(thanks|thank you|done|bye|resolved)\b/i;

export function signalsDone(text: string): boolean {
  return RESOLUTION_PATTERN.test(text);
}

/** USSD DTMF asks for an agent with key 9 in any sub-menu. */
export const USSD_ESCALATE_KEY = '9';
