import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { VoiceSessionRecord } from '../../database/repositories/voice.repository.js';
import {
  canTransition,
  isTerminal,
  requestsHuman,
  signalsDone,
  transitionSession,
  transitionsFor
} from './voice-session.js';

function session(state: VoiceSessionRecord['state']): VoiceSessionRecord {
  return {
    id: 'vsession-1',
    channel: 'ivr',
    state,
    phone: '+2348012345678',
    locale: 'en',
    menuState: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('voice session state machine', () => {
  it('follows the happy path intake → triage → advisory → resolved', () => {
    let s = session('intake');
    s = transitionSession(s, 'triage');
    expect(s.state).toBe('triage');
    s = transitionSession(s, 'advisory');
    expect(s.state).toBe('advisory');
    s = transitionSession(s, 'resolved');
    expect(s.state).toBe('resolved');
    expect(isTerminal(s.state)).toBe(true);
  });

  it('allows escalation from every non-terminal state', () => {
    for (const from of ['intake', 'triage', 'advisory'] as const) {
      expect(canTransition(from, 'escalated')).toBe(true);
    }
    expect(canTransition('escalated', 'resolved')).toBe(true);
  });

  it('rejects skipping states and backwards jumps with 409 Conflict', () => {
    expect(() => transitionSession(session('intake'), 'advisory')).toThrow(ConflictException);
    expect(() => transitionSession(session('advisory'), 'triage')).toThrow(ConflictException);
    expect(() => transitionSession(session('escalated'), 'advisory')).toThrow(ConflictException);
  });

  it('resolved is terminal — no further transitions', () => {
    expect(transitionsFor('resolved')).toEqual([]);
    expect(() => transitionSession(session('resolved'), 'escalated')).toThrow(ConflictException);
  });

  it('same-state transition is a no-op returning the record unchanged', () => {
    const s = session('triage');
    expect(transitionSession(s, 'triage')).toBe(s);
  });

  it('detects escalation and done signals in free text', () => {
    expect(requestsHuman('I want to speak to an agent please')).toBe(true);
    expect(requestsHuman('connect me with an agronomist')).toBe(true);
    expect(requestsHuman('my maize has worms')).toBe(false);
    expect(signalsDone('thanks, that is all')).toBe(true);
    expect(signalsDone('what about fertilizer')).toBe(false);
  });
});
