import { NotFoundException } from '@nestjs/common';

/**
 * DI token for the intent-session repository. Registered module-locally by
 * VoiceTellerModule so persistence.tokens.ts / database.module.ts stay
 * untouched (Stage 27 sibling PRs union-merge those shared files).
 */
export const VOICE_INTENT_SESSION_REPOSITORY = Symbol('VOICE_INTENT_SESSION_REPOSITORY');

/**
 * Voice Teller intent-session persistence port (Stage 27, Innovation 6).
 * Rows map to voice.intent_sessions (infra/postgres/064_voice_intents.sql) —
 * the audit + call-deflection analytics record of every transactional voice
 * intent attempt. Privacy invariant (NDPA 2023): `msisdnHmac` is a salted
 * HMAC-SHA256 hex digest (voice/msisdn-crypto.ts); the plaintext phone
 * number NEVER reaches this port. In-memory is the default driver; the pg
 * implementation behind the same port is selected by VoiceTellerModule when
 * the global PG_POOL is configured.
 */

export const VOICE_INTENT_CHANNELS = ['ivr', 'ussd_voice'] as const;
export type VoiceIntentChannel = (typeof VOICE_INTENT_CHANNELS)[number];

export const VOICE_INTENT_RESULTS = ['ok', 'unavailable', 'escalated'] as const;
export type VoiceIntentResult = (typeof VOICE_INTENT_RESULTS)[number];

export interface VoiceIntentSessionRecord {
  id: string;
  /** Set only after successful PIN verification; null otherwise. */
  userId?: string;
  channel: VoiceIntentChannel;
  /** Grammar-slot intent id (voice/intent-router.ts VOICE_INTENT_IDS). */
  intent: string;
  /** Salted HMAC-SHA256 of the caller MSISDN — never plaintext. */
  msisdnHmac: string;
  result: VoiceIntentResult;
  durationMs: number;
  createdAt: string;
}

export interface VoiceIntentSessionCriteria {
  userId?: string;
  msisdnHmac?: string;
  intent?: string;
  result?: VoiceIntentResult;
}

export interface VoiceIntentSessionRepository {
  create(record: VoiceIntentSessionRecord): Promise<VoiceIntentSessionRecord>;
  findById(id: string): Promise<VoiceIntentSessionRecord | undefined>;
  getById(id: string): Promise<VoiceIntentSessionRecord>;
  find(criteria: VoiceIntentSessionCriteria): Promise<VoiceIntentSessionRecord[]>;
}

export class InMemoryVoiceIntentSessionRepository implements VoiceIntentSessionRepository {
  private readonly items = new Map<string, VoiceIntentSessionRecord>();

  async create(record: VoiceIntentSessionRecord): Promise<VoiceIntentSessionRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VoiceIntentSessionRecord | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async getById(id: string): Promise<VoiceIntentSessionRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Voice intent session ${id} not found`);
    }
    return found;
  }

  async find(criteria: VoiceIntentSessionCriteria): Promise<VoiceIntentSessionRecord[]> {
    return [...this.items.values()]
      .filter(
        (record) =>
          (!criteria.userId || record.userId === criteria.userId) &&
          (!criteria.msisdnHmac || record.msisdnHmac === criteria.msisdnHmac) &&
          (!criteria.intent || record.intent === criteria.intent) &&
          (!criteria.result || record.result === criteria.result)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
}

export function createInMemoryVoiceIntentSessionRepository(): InMemoryVoiceIntentSessionRepository {
  return new InMemoryVoiceIntentSessionRepository();
}
