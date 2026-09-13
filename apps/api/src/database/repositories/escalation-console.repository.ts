import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Agronomist SLA console persistence ports (Stage 27 innovation #19). Rows
 * map to voice.escalation_cases (infra/postgres/078_agronomist_console.sql).
 * In-memory implementations are the default for local dev and CI; the pg
 * implementations behind the same ports are selected by DatabaseModule when
 * PG_POOL is configured.
 *
 * Claim is a compare-and-swap: queued → assigned with exactly one winner.
 * The pg implementation compiles the claim to a single guarded UPDATE whose
 * precondition pins status='queued' (the migration-052 claim-lease
 * doctrine); the in-memory implementation is single-threaded so the same
 * semantics hold. A losing claim throws ConflictException (409), never
 * silently reassigns.
 */

export const ESCALATION_CASE_STATUSES = ['queued', 'assigned', 'answered', 'closed'] as const;
export type EscalationCaseStatus = (typeof ESCALATION_CASE_STATUSES)[number];

export const ESCALATION_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type EscalationDeliveryStatus = (typeof ESCALATION_DELIVERY_STATUSES)[number];

export interface EscalationCaseRecord {
  id: string;
  sessionId: string;
  /** Originating wave-VOICE agent case (voice.agent_cases), when mirrored. */
  agentCaseId?: string;
  /** Farmer user id when the session phone resolved to a registered user. */
  userId?: string;
  phone: string;
  /** Reply channel for the answer push (sms today; voice callback later). */
  channel: string;
  /** Programme cohort tag for the SLA deliverable export. */
  cohort?: string;
  topic?: string;
  locale: string;
  priority: 'normal' | 'high';
  status: EscalationCaseStatus;
  /** Business-hours-aware SLA deadline (ISO instant). */
  slaDueAt: string;
  /** Dedupe marker set by the breacher sweep (breach event emitted once). */
  slaBreachedAt?: string;
  assignedTo?: string;
  assignedAt?: string;
  answerText?: string;
  answeredAt?: string;
  deliveryStatus: EscalationDeliveryStatus;
  deliveryAttempts: number;
  deliveryNote?: string;
  deliveredAt?: string;
  qualityScore?: number;
  qualityScoredBy?: string;
  qualityScoredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EscalationCaseCriteria {
  status?: EscalationCaseStatus;
  assignedTo?: string;
  cohort?: string;
  /** Cases whose SLA deadline is at/before this ISO instant. */
  slaDueAtOrBefore?: string;
  /** Only cases the breacher sweep has not flagged yet. */
  slaNotBreached?: boolean;
  /** Only cases with this delivery status (answer retry sweep). */
  deliveryStatus?: EscalationDeliveryStatus;
}

export interface ClaimResult {
  won: boolean;
  record: EscalationCaseRecord;
}

export interface EscalationCaseRepository {
  create(record: EscalationCaseRecord): Promise<EscalationCaseRecord>;
  findById(id: string): Promise<EscalationCaseRecord | undefined>;
  getById(id: string): Promise<EscalationCaseRecord>;
  /** Idempotent enqueue lookup: one console case per agent case. */
  findByAgentCaseId(agentCaseId: string): Promise<EscalationCaseRecord | undefined>;
  /**
   * CAS claim queued → assigned. Exactly one concurrent caller wins; losers
   * get { won: false, record: <current row> } so the service can answer 409
   * with the honest state. Never reassigns an already-claimed case.
   */
  claim(id: string, agentId: string, at: string): Promise<ClaimResult>;
  /**
   * Guarded answer-delivery write. Two honest outcomes, both atomic:
   *  - delivered: status assigned → answered with answer/answeredAt/
   *    deliveryStatus='delivered' in ONE write (the DB CHECK makes this
   *    the only way a row can reach 'answered');
   *  - failed: answer text is recorded on the still-assigned case with
   *    deliveryStatus='failed' for the retry sweep. The case is never
   *    marked answered-to-farmer until the channel confirms.
   * Throws ConflictException when the case is not in 'assigned'.
   */
  recordAnswerDelivery(
    id: string,
    patch: {
      answerText: string;
      delivery: 'delivered' | 'failed';
      deliveryNote?: string;
      at: string;
    }
  ): Promise<EscalationCaseRecord>;
  /** Supervisor quality sampling (assigned/answered/closed cases). */
  recordQuality(
    id: string,
    patch: { score: number; scoredBy: string; at: string; close?: boolean }
  ): Promise<EscalationCaseRecord>;
  /** First-time breach flag; no-op when already flagged (sweep dedupe). */
  markSlaBreached(id: string, at: string): Promise<EscalationCaseRecord>;
  update(id: string, patch: Partial<EscalationCaseRecord>): Promise<EscalationCaseRecord>;
  /** Queue order: soonest SLA deadline first, then id for determinism. */
  find(criteria: EscalationCaseCriteria): Promise<EscalationCaseRecord[]>;
}

// -- In-memory implementations (default driver) ------------------------------

export class InMemoryEscalationCaseRepository implements EscalationCaseRepository {
  private readonly items = new Map<string, EscalationCaseRecord>();

  async create(record: EscalationCaseRecord): Promise<EscalationCaseRecord> {
    this.items.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async findById(id: string): Promise<EscalationCaseRecord | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async getById(id: string): Promise<EscalationCaseRecord> {
    const found = await this.findById(id);
    if (!found) {
      throw new NotFoundException(`Escalation case ${id} not found`);
    }
    return found;
  }

  async findByAgentCaseId(agentCaseId: string): Promise<EscalationCaseRecord | undefined> {
    for (const record of this.items.values()) {
      if (record.agentCaseId === agentCaseId) {
        return structuredClone(record);
      }
    }
    return undefined;
  }

  async claim(id: string, agentId: string, at: string): Promise<ClaimResult> {
    // Atomic by construction: no await between the read and the write, so
    // interleaved async callers can never both observe status='queued'
    // (the single-threaded event loop runs this check-and-set to
    // completion before any competitor's continuation).
    const current = this.items.get(id);
    if (!current) {
      throw new NotFoundException(`Escalation case ${id} not found`);
    }
    if (current.status !== 'queued') {
      return { won: false, record: structuredClone(current) };
    }
    const claimed: EscalationCaseRecord = {
      ...current,
      status: 'assigned',
      assignedTo: agentId,
      assignedAt: at,
      updatedAt: at
    };
    this.items.set(id, structuredClone(claimed));
    return { won: true, record: structuredClone(claimed) };
  }

  async recordAnswerDelivery(
    id: string,
    patch: { answerText: string; delivery: 'delivered' | 'failed'; deliveryNote?: string; at: string }
  ): Promise<EscalationCaseRecord> {
    const current = await this.getById(id);
    if (current.status !== 'assigned') {
      throw new ConflictException(
        `Escalation case ${id} is ${current.status}; answers require an assigned case`
      );
    }
    const delivered = patch.delivery === 'delivered';
    const updated: EscalationCaseRecord = {
      ...current,
      answerText: patch.answerText,
      deliveryStatus: patch.delivery,
      deliveryAttempts: current.deliveryAttempts + 1,
      ...(patch.deliveryNote ? { deliveryNote: patch.deliveryNote } : {}),
      ...(delivered
        ? { status: 'answered' as const, answeredAt: patch.at, deliveredAt: patch.at }
        : {}),
      updatedAt: patch.at
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async recordQuality(
    id: string,
    patch: { score: number; scoredBy: string; at: string; close?: boolean }
  ): Promise<EscalationCaseRecord> {
    const current = await this.getById(id);
    if (current.status !== 'answered' && current.status !== 'closed') {
      throw new ConflictException(
        `Escalation case ${id} is ${current.status}; quality sampling requires an answered case`
      );
    }
    const updated: EscalationCaseRecord = {
      ...current,
      qualityScore: patch.score,
      qualityScoredBy: patch.scoredBy,
      qualityScoredAt: patch.at,
      ...(patch.close ? { status: 'closed' as const } : {}),
      updatedAt: patch.at
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async markSlaBreached(id: string, at: string): Promise<EscalationCaseRecord> {
    const current = await this.getById(id);
    if (current.slaBreachedAt) {
      return current;
    }
    const updated: EscalationCaseRecord = { ...current, slaBreachedAt: at, updatedAt: at };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async update(id: string, patch: Partial<EscalationCaseRecord>): Promise<EscalationCaseRecord> {
    const current = await this.getById(id);
    const updated: EscalationCaseRecord = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    this.items.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async find(criteria: EscalationCaseCriteria): Promise<EscalationCaseRecord[]> {
    return [...this.items.values()]
      .filter(
        (record) =>
          (!criteria.status || record.status === criteria.status) &&
          (!criteria.assignedTo || record.assignedTo === criteria.assignedTo) &&
          (!criteria.cohort || record.cohort === criteria.cohort) &&
          (!criteria.slaDueAtOrBefore || record.slaDueAt <= criteria.slaDueAtOrBefore) &&
          (!criteria.slaNotBreached || !record.slaBreachedAt) &&
          (!criteria.deliveryStatus || record.deliveryStatus === criteria.deliveryStatus)
      )
      .sort((a, b) => a.slaDueAt.localeCompare(b.slaDueAt) || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }
}

export function createInMemoryEscalationCaseRepository(): InMemoryEscalationCaseRepository {
  return new InMemoryEscalationCaseRepository();
}
