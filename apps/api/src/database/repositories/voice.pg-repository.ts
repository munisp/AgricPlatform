import { NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  AgentCaseCriteria,
  AgentCaseRecord,
  AgentCaseRepository,
  VoiceChannel,
  VoiceSessionCriteria,
  VoiceSessionRecord,
  VoiceSessionRepository,
  VoiceTurnRecord,
  VoiceTurnRepository
} from './voice.repository.js';

/**
 * PostgreSQL implementations over voice.voice_sessions / voice.voice_turns /
 * voice.agent_cases (infra/postgres/027_voice.sql). Standalone classes (not
 * PgRepositoryBase) so the query shapes stay explicit; behaviour matches the
 * in-memory implementations (queue order, NotFound semantics).
 */
export class PgVoiceSessionRepository implements VoiceSessionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VoiceSessionRecord): Promise<VoiceSessionRecord> {
    await this.pool.query(
      'INSERT INTO voice.voice_sessions ' +
        '(id, channel, state, phone, nin_ref, farmer_user_id, locale, crop, symptom_category, ' +
        'menu_state, active_case_id, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [
        record.id,
        record.channel,
        record.state,
        record.phone,
        record.ninRef ?? null,
        record.farmerUserId ?? null,
        record.locale,
        record.crop ?? null,
        record.symptomCategory ?? null,
        JSON.stringify(record.menuState ?? {}),
        record.activeCaseId ?? null,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<VoiceSessionRecord | undefined> {
    const result = await this.pool.query(
      'SELECT id, channel, state, phone, nin_ref, farmer_user_id, locale, crop, symptom_category, ' +
        'menu_state, active_case_id, created_at, updated_at FROM voice.voice_sessions WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
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
    await this.pool.query(
      'UPDATE voice.voice_sessions SET channel = $2, state = $3, phone = $4, nin_ref = $5, ' +
        'farmer_user_id = $6, locale = $7, crop = $8, symptom_category = $9, menu_state = $10, ' +
        'active_case_id = $11, updated_at = $12 WHERE id = $1',
      [
        updated.id,
        updated.channel,
        updated.state,
        updated.phone,
        updated.ninRef ?? null,
        updated.farmerUserId ?? null,
        updated.locale,
        updated.crop ?? null,
        updated.symptomCategory ?? null,
        JSON.stringify(updated.menuState ?? {}),
        updated.activeCaseId ?? null,
        updated.updatedAt
      ]
    );
    return updated;
  }

  async find(criteria: VoiceSessionCriteria): Promise<VoiceSessionRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.phone) {
      params.push(criteria.phone);
      clauses.push(`phone = $${params.length}`);
    }
    if (criteria.farmerUserId) {
      params.push(criteria.farmerUserId);
      clauses.push(`farmer_user_id = $${params.length}`);
    }
    if (criteria.state) {
      params.push(criteria.state);
      clauses.push(`state = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      'SELECT id, channel, state, phone, nin_ref, farmer_user_id, locale, crop, symptom_category, ' +
        `menu_state, active_case_id, created_at, updated_at FROM voice.voice_sessions${where} ` +
        'ORDER BY created_at ASC, id ASC',
      params
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): VoiceSessionRecord {
    return {
      id: row.id as string,
      channel: row.channel as VoiceChannel,
      state: row.state as VoiceSessionRecord['state'],
      phone: row.phone as string,
      ninRef: (row.nin_ref as string | null) ?? undefined,
      farmerUserId: (row.farmer_user_id as string | null) ?? undefined,
      locale: row.locale as string,
      crop: (row.crop as string | null) ?? undefined,
      symptomCategory: (row.symptom_category as string | null) ?? undefined,
      menuState: (row.menu_state ?? {}) as Record<string, unknown>,
      activeCaseId: (row.active_case_id as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString()
    };
  }
}

export class PgVoiceTurnRepository implements VoiceTurnRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: VoiceTurnRecord): Promise<VoiceTurnRecord> {
    await this.pool.query(
      'INSERT INTO voice.voice_turns ' +
        '(id, session_id, turn_index, speaker, text, cited_chunk_ids, confidence, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        record.id,
        record.sessionId,
        record.turnIndex,
        record.speaker,
        record.text,
        JSON.stringify(record.citedChunkIds),
        record.confidence ?? null,
        record.createdAt
      ]
    );
    return record;
  }

  async nextIndex(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COALESCE(MAX(turn_index), 0) + 1 AS next FROM voice.voice_turns WHERE session_id = $1',
      [sessionId]
    );
    return Number(result.rows[0].next);
  }

  async listForSession(sessionId: string): Promise<VoiceTurnRecord[]> {
    const result = await this.pool.query(
      'SELECT id, session_id, turn_index, speaker, text, cited_chunk_ids, confidence, created_at ' +
        'FROM voice.voice_turns WHERE session_id = $1 ORDER BY turn_index ASC, id ASC',
      [sessionId]
    );
    return result.rows.map((row) => this.turnFromRow(row));
  }

  private turnFromRow(row: Record<string, unknown>): VoiceTurnRecord {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      turnIndex: Number(row.turn_index),
      speaker: row.speaker as VoiceTurnRecord['speaker'],
      text: row.text as string,
      citedChunkIds: (row.cited_chunk_ids ?? []) as string[],
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      createdAt: new Date(row.created_at as string).toISOString()
    };
  }
}

export class PgAgentCaseRepository implements AgentCaseRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: AgentCaseRecord): Promise<AgentCaseRecord> {
    await this.pool.query(
      'INSERT INTO voice.agent_cases ' +
        '(id, session_id, farmer_user_id, phone, channel, status, reason, priority, sla_due_at, ' +
        'assigned_agent_id, suggested_answer, citation_chunk_ids, response, responded_at, ' +
        'created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
      [
        record.id,
        record.sessionId,
        record.farmerUserId ?? null,
        record.phone,
        record.channel,
        record.status,
        record.reason,
        record.priority,
        record.slaDueAt,
        record.assignedAgentId ?? null,
        record.suggestedAnswer ?? null,
        JSON.stringify(record.citationChunkIds),
        record.response ?? null,
        record.respondedAt ?? null,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<AgentCaseRecord | undefined> {
    const result = await this.pool.query(
      'SELECT id, session_id, farmer_user_id, phone, channel, status, reason, priority, ' +
        'sla_due_at, assigned_agent_id, suggested_answer, citation_chunk_ids, response, ' +
        'responded_at, created_at, updated_at FROM voice.agent_cases WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
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
    await this.pool.query(
      'UPDATE voice.agent_cases SET status = $2, reason = $3, priority = $4, sla_due_at = $5, ' +
        'assigned_agent_id = $6, suggested_answer = $7, citation_chunk_ids = $8, response = $9, ' +
        'responded_at = $10, updated_at = $11 WHERE id = $1',
      [
        updated.id,
        updated.status,
        updated.reason,
        updated.priority,
        updated.slaDueAt,
        updated.assignedAgentId ?? null,
        updated.suggestedAnswer ?? null,
        JSON.stringify(updated.citationChunkIds),
        updated.response ?? null,
        updated.respondedAt ?? null,
        updated.updatedAt
      ]
    );
    return updated;
  }

  async find(criteria: AgentCaseCriteria): Promise<AgentCaseRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      clauses.push(`status = $${params.length}`);
    }
    if (criteria.assignedAgentId) {
      params.push(criteria.assignedAgentId);
      clauses.push(`assigned_agent_id = $${params.length}`);
    }
    if (criteria.slaDueAtOrBefore) {
      params.push(criteria.slaDueAtOrBefore);
      clauses.push(`sla_due_at <= $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      'SELECT id, session_id, farmer_user_id, phone, channel, status, reason, priority, ' +
        'sla_due_at, assigned_agent_id, suggested_answer, citation_chunk_ids, response, ' +
        `responded_at, created_at, updated_at FROM voice.agent_cases${where} ` +
        'ORDER BY sla_due_at ASC, id ASC',
      params
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): AgentCaseRecord {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      farmerUserId: (row.farmer_user_id as string | null) ?? undefined,
      phone: row.phone as string,
      channel: row.channel as VoiceChannel,
      status: row.status as AgentCaseRecord['status'],
      reason: row.reason as AgentCaseRecord['reason'],
      priority: row.priority as AgentCaseRecord['priority'],
      slaDueAt: new Date(row.sla_due_at as string).toISOString(),
      assignedAgentId: (row.assigned_agent_id as string | null) ?? undefined,
      suggestedAnswer: (row.suggested_answer as string | null) ?? undefined,
      citationChunkIds: (row.citation_chunk_ids ?? []) as string[],
      response: (row.response as string | null) ?? undefined,
      respondedAt: row.responded_at
        ? new Date(row.responded_at as string).toISOString()
        : undefined,
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString()
    };
  }
}

export function createPgVoiceSessionRepository(pool: pg.Pool): PgVoiceSessionRepository {
  return new PgVoiceSessionRepository(pool);
}

export function createPgVoiceTurnRepository(pool: pg.Pool): PgVoiceTurnRepository {
  return new PgVoiceTurnRepository(pool);
}

export function createPgAgentCaseRepository(pool: pg.Pool): PgAgentCaseRepository {
  return new PgAgentCaseRepository(pool);
}
