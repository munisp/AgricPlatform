import { NotFoundException } from '@nestjs/common';

/**
 * Voice-agronomist persistence ports (wave VOICE). Rows map to
 * voice.voice_sessions / voice.voice_turns / voice.agent_cases
 * (infra/postgres/027_voice.sql). In-memory implementations are the default
 * for local dev and CI; the pg implementations behind the same ports are
 * selected by DatabaseModule when PG_POOL is configured.
 */

export const VOICE_CHANNELS = ['ivr', 'ussd', 'assisted'] as const;
export type VoiceChannel = (typeof VOICE_CHANNELS)[number];

export const VOICE_SESSION_STATES = [
  'intake',
  'triage',
  'advisory',
  'escalated',
  'resolved'
] as const;
export type VoiceSessionState = (typeof VOICE_SESSION_STATES)[number];

export const AGENT_CASE_STATUSES = ['open', 'assigned', 'responded', 'resolved'] as const;
export type AgentCaseStatus = (typeof AGENT_CASE_STATUSES)[number];

export const AGENT_CASE_REASONS = ['requested', 'low_confidence', 'no_grounding'] as const;
export type AgentCaseReason = (typeof AGENT_CASE_REASONS)[number];

export interface VoiceSessionRecord {
  id: string;
  channel: VoiceChannel;
  state: VoiceSessionState;
  phone: string;
  /** Optional, UNVERIFIED national-ID reference dictated by the farmer. */
  ninRef?: string;
  farmerUserId?: string;
  /** Captured locale (en/ha/yo/ig); responses stay en-only this wave. */
  locale: string;
  crop?: string;
  symptomCategory?: string;
  /** Opaque USSD menu-engine state (engine is a pure function). */
  menuState: Record<string, unknown>;
  activeCaseId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceTurnRecord {
  id: string;
  sessionId: string;
  turnIndex: number;
  speaker: 'farmer' | 'assistant' | 'agent';
  text: string;
  /** RAG grounding: corpus chunk ids this turn's advice is grounded in. */
  citedChunkIds: string[];
  confidence?: number;
  createdAt: string;
}

export interface AgentCaseRecord {
  id: string;
  sessionId: string;
  farmerUserId?: string;
  phone: string;
  channel: VoiceChannel;
  status: AgentCaseStatus;
  reason: AgentCaseReason;
  priority: 'normal' | 'high';
  slaDueAt: string;
  assignedAgentId?: string;
  suggestedAnswer?: string;
  citationChunkIds: string[];
  response?: string;
  respondedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceSessionCriteria {
  phone?: string;
  farmerUserId?: string;
  state?: VoiceSessionState;
}

export interface VoiceSessionRepository {
  create(record: VoiceSessionRecord): Promise<VoiceSessionRecord>;
  findById(id: string): Promise<VoiceSessionRecord | undefined>;
  getById(id: string): Promise<VoiceSessionRecord>;
  update(id: string, patch: Partial<VoiceSessionRecord>): Promise<VoiceSessionRecord>;
  find(criteria: VoiceSessionCriteria): Promise<VoiceSessionRecord[]>;
}

export interface VoiceTurnRepository {
  create(record: VoiceTurnRecord): Promise<VoiceTurnRecord>;
  /** Next 1-based turn index for the session transcript. */
  nextIndex(sessionId: string): Promise<number>;
  listForSession(sessionId: string): Promise<VoiceTurnRecord[]>;
}

export interface AgentCaseCriteria {
  status?: AgentCaseStatus;
  assignedAgentId?: string;
  /** When set, only cases whose SLA deadline is at/before this ISO instant. */
  slaDueAtOrBefore?: string;
}

export interface AgentCaseRepository {
  create(record: AgentCaseRecord): Promise<AgentCaseRecord>;
  findById(id: string): Promise<AgentCaseRecord | undefined>;
  getById(id: string): Promise<AgentCaseRecord>;
  update(id: string, patch: Partial<AgentCaseRecord>): Promise<AgentCaseRecord>;
  /** Queue order: soonest SLA deadline first, then id for determinism. */
  find(criteria: AgentCaseCriteria): Promise<AgentCaseRecord[]>;
}

// -- In-memory implementations (default driver) ------------------------------

export class InMemoryVoiceSessionRepository implements VoiceSessionRepository {
  private readonly items = new Map<string, VoiceSessionRecord>();

  async create(record: VoiceSessionRecord): Promise<VoiceSessionRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<VoiceSessionRecord | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async getById(id: string): Promise<VoiceSessionRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Voice session ${id} not found`);
    }
    return found;
  }

  async update(id: string, patch: Partial<VoiceSessionRecord>): Promise<VoiceSessionRecord> {
    const current = await this.getById(id);
    const updated: VoiceSessionRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async find(criteria: VoiceSessionCriteria): Promise<VoiceSessionRecord[]> {
    return [...this.items.values()]
      .filter(
        (record) =>
          (!criteria.phone || record.phone === criteria.phone) &&
          (!criteria.farmerUserId || record.farmerUserId === criteria.farmerUserId) &&
          (!criteria.state || record.state === criteria.state)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
}

export class InMemoryVoiceTurnRepository implements VoiceTurnRepository {
  private readonly items = new Map<string, VoiceTurnRecord>();

  async create(record: VoiceTurnRecord): Promise<VoiceTurnRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async nextIndex(sessionId: string): Promise<number> {
    let max = 0;
    for (const record of this.items.values()) {
      if (record.sessionId === sessionId && record.turnIndex > max) {
        max = record.turnIndex;
      }
    }
    return max + 1;
  }

  async listForSession(sessionId: string): Promise<VoiceTurnRecord[]> {
    return [...this.items.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((a, b) => a.turnIndex - b.turnIndex || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
}

export class InMemoryAgentCaseRepository implements AgentCaseRepository {
  private readonly items = new Map<string, AgentCaseRecord>();

  async create(record: AgentCaseRecord): Promise<AgentCaseRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<AgentCaseRecord | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async getById(id: string): Promise<AgentCaseRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Agent case ${id} not found`);
    }
    return found;
  }

  async update(id: string, patch: Partial<AgentCaseRecord>): Promise<AgentCaseRecord> {
    const current = await this.getById(id);
    const updated: AgentCaseRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async find(criteria: AgentCaseCriteria): Promise<AgentCaseRecord[]> {
    return [...this.items.values()]
      .filter(
        (record) =>
          (!criteria.status || record.status === criteria.status) &&
          (!criteria.assignedAgentId || record.assignedAgentId === criteria.assignedAgentId) &&
          (!criteria.slaDueAtOrBefore || record.slaDueAt <= criteria.slaDueAtOrBefore)
      )
      .sort((a, b) => a.slaDueAt.localeCompare(b.slaDueAt) || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
}

export function createInMemoryVoiceSessionRepository(): InMemoryVoiceSessionRepository {
  return new InMemoryVoiceSessionRepository();
}

export function createInMemoryVoiceTurnRepository(): InMemoryVoiceTurnRepository {
  return new InMemoryVoiceTurnRepository();
}

export function createInMemoryAgentCaseRepository(): InMemoryAgentCaseRepository {
  return new InMemoryAgentCaseRepository();
}
