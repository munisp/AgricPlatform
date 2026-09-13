import { ConflictException, NotFoundException } from '@nestjs/common';
import type pg from 'pg';
import type {
  ClaimResult,
  EscalationCaseCriteria,
  EscalationCaseRecord,
  EscalationCaseRepository
} from './escalation-console.repository.js';

const COLUMNS =
  'id, session_id, agent_case_id, user_id, phone, channel, cohort, topic, locale, priority, ' +
  'status, sla_due_at, sla_breached_at, assigned_to, assigned_at, answer_text, answered_at, ' +
  'delivery_status, delivery_attempts, delivery_note, delivered_at, quality_score, ' +
  'quality_scored_by, quality_scored_at, created_at, updated_at';

/**
 * PostgreSQL implementation over voice.escalation_cases
 * (infra/postgres/078_agronomist_console.sql). Standalone class (not
 * PgRepositoryBase) so the query shapes stay explicit; behaviour matches
 * the in-memory implementation (queue order, NotFound semantics).
 *
 * The claim is ONE guarded UPDATE whose precondition pins
 * status='queued' (migration-052 claim-lease doctrine): two concurrent
 * claimants can never both win — the loser's UPDATE matches zero rows and
 * re-reads the honest winner.
 */
export class PgEscalationCaseRepository implements EscalationCaseRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(record: EscalationCaseRecord): Promise<EscalationCaseRecord> {
    await this.pool.query(
      'INSERT INTO voice.escalation_cases ' +
        '(id, session_id, agent_case_id, user_id, phone, channel, cohort, topic, locale, ' +
        'priority, status, sla_due_at, sla_breached_at, assigned_to, assigned_at, answer_text, ' +
        'answered_at, delivery_status, delivery_attempts, delivery_note, delivered_at, ' +
        'quality_score, quality_scored_by, quality_scored_at, created_at, updated_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)',
      [
        record.id,
        record.sessionId,
        record.agentCaseId ?? null,
        record.userId ?? null,
        record.phone,
        record.channel,
        record.cohort ?? null,
        record.topic ?? null,
        record.locale,
        record.priority,
        record.status,
        record.slaDueAt,
        record.slaBreachedAt ?? null,
        record.assignedTo ?? null,
        record.assignedAt ?? null,
        record.answerText ?? null,
        record.answeredAt ?? null,
        record.deliveryStatus,
        record.deliveryAttempts,
        record.deliveryNote ?? null,
        record.deliveredAt ?? null,
        record.qualityScore ?? null,
        record.qualityScoredBy ?? null,
        record.qualityScoredAt ?? null,
        record.createdAt,
        record.updatedAt
      ]
    );
    return record;
  }

  async findById(id: string): Promise<EscalationCaseRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM voice.escalation_cases WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<EscalationCaseRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Escalation case ${id} not found`);
    }
    return found;
  }

  async findByAgentCaseId(agentCaseId: string): Promise<EscalationCaseRecord | undefined> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM voice.escalation_cases WHERE agent_case_id = $1`,
      [agentCaseId]
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : undefined;
  }

  /**
   * CAS claim queued → assigned. Single guarded UPDATE: exactly one
   * concurrent claimant's statement matches the status='queued'
   * precondition; the loser matches zero rows and re-reads the winner.
   */
  async claim(id: string, agentId: string, at: string): Promise<ClaimResult> {
    const result = await this.pool.query(
      'UPDATE voice.escalation_cases ' +
        "SET status = 'assigned', assigned_to = $2, assigned_at = $3, updated_at = $3 " +
        `WHERE id = $1 AND status = 'queued' RETURNING ${COLUMNS}`,
      [id, agentId, at]
    );
    if (result.rows[0]) {
      return { won: true, record: this.fromRow(result.rows[0]) };
    }
    // Lost the race (or never existed): getById answers 404 honestly, and a
    // present row is the winner's state for the 409 response.
    return { won: false, record: await this.getById(id) };
  }

  /**
   * Guarded answer-delivery write. The 'delivered' arm flips
   * status → answered in the SAME statement that sets
   * delivery_status='delivered' — the answered_requires_delivery CHECK
   * makes any other path to 'answered' a constraint violation.
   */
  async recordAnswerDelivery(
    id: string,
    patch: { answerText: string; delivery: 'delivered' | 'failed'; deliveryNote?: string; at: string }
  ): Promise<EscalationCaseRecord> {
    const delivered = patch.delivery === 'delivered';
    const result = await this.pool.query(
      'UPDATE voice.escalation_cases SET ' +
        'answer_text = $2, delivery_status = $3, ' +
        'delivery_attempts = delivery_attempts + 1, delivery_note = $4, ' +
        (delivered
          ? "status = 'answered', answered_at = $5, delivered_at = $5, "
          : '') +
        'updated_at = $5 ' +
        `WHERE id = $1 AND status = 'assigned' RETURNING ${COLUMNS}`,
      [id, patch.answerText, patch.delivery, patch.deliveryNote ?? null, patch.at]
    );
    if (!result.rows[0]) {
      const current = await this.getById(id);
      throw new ConflictException(
        `Escalation case ${id} is ${current.status}; answers require an assigned case`
      );
    }
    return this.fromRow(result.rows[0]);
  }

  async recordQuality(
    id: string,
    patch: { score: number; scoredBy: string; at: string; close?: boolean }
  ): Promise<EscalationCaseRecord> {
    const result = await this.pool.query(
      'UPDATE voice.escalation_cases SET ' +
        'quality_score = $2, quality_scored_by = $3, quality_scored_at = $4, ' +
        (patch.close ? "status = 'closed', " : '') +
        'updated_at = $4 ' +
        "WHERE id = $1 AND status IN ('answered', 'closed') RETURNING " + COLUMNS,
      [id, patch.score, patch.scoredBy, patch.at]
    );
    if (!result.rows[0]) {
      const current = await this.getById(id);
      throw new ConflictException(
        `Escalation case ${id} is ${current.status}; quality sampling requires an answered case`
      );
    }
    return this.fromRow(result.rows[0]);
  }

  /** Guarded first-time breach flag — concurrent sweeps converge, event once. */
  async markSlaBreached(id: string, at: string): Promise<EscalationCaseRecord> {
    const result = await this.pool.query(
      'UPDATE voice.escalation_cases SET sla_breached_at = $2, updated_at = $2 ' +
        `WHERE id = $1 AND sla_breached_at IS NULL RETURNING ${COLUMNS}`,
      [id, at]
    );
    if (result.rows[0]) {
      return this.fromRow(result.rows[0]);
    }
    return this.getById(id);
  }

  async update(id: string, patch: Partial<EscalationCaseRecord>): Promise<EscalationCaseRecord> {
    const current = await this.getById(id);
    const updated: EscalationCaseRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    await this.pool.query(
      'UPDATE voice.escalation_cases SET ' +
        'cohort = $2, topic = $3, priority = $4, status = $5, sla_due_at = $6, ' +
        'sla_breached_at = $7, updated_at = $8 ' +
        'WHERE id = $1',
      [
        updated.id,
        updated.cohort ?? null,
        updated.topic ?? null,
        updated.priority,
        updated.status,
        updated.slaDueAt,
        updated.slaBreachedAt ?? null,
        updated.updatedAt
      ]
    );
    return updated;
  }

  async find(criteria: EscalationCaseCriteria): Promise<EscalationCaseRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (criteria.status) {
      params.push(criteria.status);
      clauses.push(`status = $${params.length}`);
    }
    if (criteria.assignedTo) {
      params.push(criteria.assignedTo);
      clauses.push(`assigned_to = $${params.length}`);
    }
    if (criteria.cohort) {
      params.push(criteria.cohort);
      clauses.push(`cohort = $${params.length}`);
    }
    if (criteria.slaDueAtOrBefore) {
      params.push(criteria.slaDueAtOrBefore);
      clauses.push(`sla_due_at <= $${params.length}`);
    }
    if (criteria.slaNotBreached) {
      clauses.push('sla_breached_at IS NULL');
    }
    if (criteria.deliveryStatus) {
      params.push(criteria.deliveryStatus);
      clauses.push(`delivery_status = $${params.length}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM voice.escalation_cases${where} ` +
        'ORDER BY sla_due_at ASC, id ASC',
      params
    );
    return result.rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Record<string, unknown>): EscalationCaseRecord {
    const iso = (value: unknown): string | undefined =>
      value ? new Date(value as string).toISOString() : undefined;
    const record: EscalationCaseRecord = {
      id: row.id as string,
      sessionId: row.session_id as string,
      ...(row.agent_case_id ? { agentCaseId: row.agent_case_id as string } : {}),
      ...(row.user_id ? { userId: row.user_id as string } : {}),
      phone: row.phone as string,
      channel: row.channel as string,
      ...(row.cohort ? { cohort: row.cohort as string } : {}),
      ...(row.topic ? { topic: row.topic as string } : {}),
      locale: row.locale as string,
      priority: row.priority as 'normal' | 'high',
      status: row.status as EscalationCaseRecord['status'],
      slaDueAt: iso(row.sla_due_at) as string,
      ...(row.sla_breached_at ? { slaBreachedAt: iso(row.sla_breached_at) } : {}),
      ...(row.assigned_to ? { assignedTo: row.assigned_to as string } : {}),
      ...(row.assigned_at ? { assignedAt: iso(row.assigned_at) } : {}),
      ...(row.answer_text ? { answerText: row.answer_text as string } : {}),
      ...(row.answered_at ? { answeredAt: iso(row.answered_at) } : {}),
      deliveryStatus: row.delivery_status as EscalationCaseRecord['deliveryStatus'],
      deliveryAttempts: Number(row.delivery_attempts),
      ...(row.delivery_note ? { deliveryNote: row.delivery_note as string } : {}),
      ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}),
      ...(row.quality_score !== null && row.quality_score !== undefined
        ? { qualityScore: Number(row.quality_score) }
        : {}),
      ...(row.quality_scored_by ? { qualityScoredBy: row.quality_scored_by as string } : {}),
      ...(row.quality_scored_at ? { qualityScoredAt: iso(row.quality_scored_at) } : {}),
      createdAt: iso(row.created_at) as string,
      updatedAt: iso(row.updated_at) as string
    };
    return record;
  }
}

export function createPgEscalationCaseRepository(pool: pg.Pool): PgEscalationCaseRepository {
  return new PgEscalationCaseRepository(pool);
}
