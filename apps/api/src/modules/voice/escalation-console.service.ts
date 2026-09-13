import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
  type OnModuleInit
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { newId } from '../../common/async-repository.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { TenantContext } from '../../common/telemetry/tenant-context.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import {
  AGENT_CASE_REPOSITORY,
  ESCALATION_CASE_REPOSITORY,
  VOICE_SESSION_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  EscalationCaseRecord,
  EscalationCaseRepository,
  EscalationCaseStatus
} from '../../database/repositories/escalation-console.repository.js';
import type {
  AgentCaseRepository,
  VoiceSessionRepository
} from '../../database/repositories/voice.repository.js';
import type { DeliveryResult } from '../integrations/adapters.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import {
  computeSlaDueAt,
  slaConfigFromEnv,
  type SlaBusinessHoursConfig
} from './sla-schedule.js';

/** Max answer-delivery attempts before the sweep stops retrying (env-overridable). */
export const ANSWER_MAX_ATTEMPTS_DEFAULT = 5;

export interface ClaimCaseResult {
  escalationCase: EscalationCaseRecord;
}

export interface AnswerCaseResult {
  escalationCase: EscalationCaseRecord;
  /** Honest channel outcome — delivered:false means nothing was sent. */
  delivery: DeliveryResult;
}

export interface SlaSweepResult {
  breached: number;
  deliveryRetried: number;
  deliveryRecovered: number;
  /** Failed-delivery cases not retried (attempt cap reached). */
  deliveryExhausted: number;
}

export interface SlaReport {
  cohort?: string;
  generatedAt: string;
  slaConfig: SlaBusinessHoursConfig;
  totals: {
    cases: number;
    byStatus: Record<EscalationCaseStatus, number>;
    answered: number;
    /** Cases past their SLA deadline while still queued/assigned. */
    breached: number;
    breachRate: number;
  };
  timeToAnswerMinutes: {
    samples: number;
    average: number | null;
    p50: number | null;
    max: number | null;
  };
  quality: {
    samples: number;
    averageScore: number | null;
  };
}

function requireUser(actor: User | null): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for the agronomist console');
  }
  return actor;
}

function isAgronomist(actor: User): boolean {
  return actor.roles.includes('agronomist') || actor.roles.includes('admin');
}

function isSupervisor(actor: User): boolean {
  return actor.roles.includes('supervisor') || actor.roles.includes('admin');
}

/** Answer-dispatch rendering: the SMS body pushed to the farmer's phone. */
export function renderAnswerMessage(record: EscalationCaseRecord, answerText: string): string {
  const topic = record.topic ? ` about ${record.topic}` : '';
  return `AgricPlatform agronomist reply${topic} (case ${record.id}):

${answerText.trim()}

Questions? Call your agent or dial the voice agronomist again.`;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

/**
 * Agronomist SLA console (Stage 27 innovation #19). The operated queue
 * behind the voice agronomist's human-escalation promise: escalations
 * emitted by VoiceService (voice.agent_case.created) are mirrored into
 * voice.escalation_cases with a business-hours SLA deadline; agronomists
 * claim cases via CAS (exactly one winner), answers are pushed back to the
 * farmer's channel through the notification drivers with HONEST delivery
 * status (stub/unreachable channel → answer recorded, status stays
 * 'assigned', delivery 'failed', retried by the sweep — never marked
 * answered-to-farmer until the channel confirms), and supervisors sample
 * answer quality.
 *
 * Rollout: the HTTP surface sits behind the `agronomist-console` feature
 * flag (default OFF, fail-closed 404).
 */
@Injectable()
export class EscalationConsoleService implements OnModuleInit {
  private readonly logger = new Logger(EscalationConsoleService.name);
  private readonly telemetry: TelemetryService;

  constructor(
    @Inject(ESCALATION_CASE_REPOSITORY)
    private readonly cases: EscalationCaseRepository,
    @Inject(AGENT_CASE_REPOSITORY)
    private readonly agentCases: AgentCaseRepository,
    @Inject(VOICE_SESSION_REPOSITORY)
    private readonly sessions: VoiceSessionRepository,
    private readonly events: DomainEventsService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationsService,
    @Optional() telemetry?: TelemetryService,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.telemetry = telemetry ?? new TelemetryService();
  }

  /**
   * Mirror queue intake: every voice agent-case escalation lands on the
   * console (idempotent per agent case — the pg unique index + the
   * find-then-create check make replays no-ops).
   */
  onModuleInit(): void {
    this.events.on('voice.agent_case.created', (event) => {
      const caseId = (event.payload as { caseId?: string }).caseId;
      if (!caseId) {
        return;
      }
      void this.enqueueFromAgentCase(caseId).catch((error: unknown) => {
        this.logger.warn(
          `console intake failed for agent case ${caseId}: ${(error as Error)?.message ?? error}`
        );
      });
    });
  }

  private slaConfig(): SlaBusinessHoursConfig {
    return slaConfigFromEnv(this.env);
  }

  private maxDeliveryAttempts(): number {
    const raw = Number(this.env.AGRONOMIST_ANSWER_MAX_ATTEMPTS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : ANSWER_MAX_ATTEMPTS_DEFAULT;
  }

  private tenantId(): string {
    return TenantContext.currentTenantId() ?? 'default';
  }

  /** Enqueue a console case for a voice agent escalation (idempotent). */
  async enqueueFromAgentCase(
    agentCaseId: string,
    now: Date = new Date()
  ): Promise<EscalationCaseRecord> {
    const existing = await this.cases.findByAgentCaseId(agentCaseId);
    if (existing) {
      return existing;
    }
    const agentCase = await this.agentCases.getById(agentCaseId);
    const session = await this.sessions.getById(agentCase.sessionId);
    const createdAt = new Date(agentCase.createdAt);
    const slaBase = Number.isNaN(createdAt.getTime()) ? now : createdAt;
    const record: EscalationCaseRecord = {
      id: newId('ecase'),
      sessionId: agentCase.sessionId,
      agentCaseId: agentCase.id,
      ...(agentCase.farmerUserId ? { userId: agentCase.farmerUserId } : {}),
      phone: agentCase.phone,
      channel: 'sms',
      ...(this.env.AGRONOMIST_SLA_COHORT ? { cohort: this.env.AGRONOMIST_SLA_COHORT } : {}),
      topic: session.crop ?? agentCase.reason,
      locale: session.locale,
      priority: agentCase.priority,
      status: 'queued',
      slaDueAt: computeSlaDueAt(slaBase, this.slaConfig()).toISOString(),
      deliveryStatus: 'pending',
      deliveryAttempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    try {
      const created = await this.cases.create(record);
      this.telemetry.increment('voice.escalations_total', 1, { status: 'queued' });
      return created;
    } catch (error) {
      // Adopt-on-race: a concurrent intake of the same agent case won the
      // unique index; converge on the winner's row.
      const twin = await this.cases.findByAgentCaseId(agentCaseId);
      if (!twin) {
        throw error;
      }
      return twin;
    }
  }

  // -- Queue -----------------------------------------------------------------

  async listCases(
    actor: User | null,
    filter: { status?: EscalationCaseStatus; cohort?: string } = {}
  ): Promise<EscalationCaseRecord[]> {
    const caller = requireUser(actor);
    if (!isAgronomist(caller) && !isSupervisor(caller)) {
      throw new ForbiddenException('The console queue requires the agronomist or supervisor role');
    }
    return this.cases.find({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.cohort ? { cohort: filter.cohort } : {})
    });
  }

  async getCase(actor: User | null, caseId: string): Promise<EscalationCaseRecord> {
    const caller = requireUser(actor);
    if (!isAgronomist(caller) && !isSupervisor(caller)) {
      throw new ForbiddenException('The console requires the agronomist or supervisor role');
    }
    return this.cases.getById(caseId);
  }

  /** CAS claim queued → assigned: exactly one concurrent winner (409 loser). */
  async claimCase(actor: User | null, caseId: string): Promise<ClaimCaseResult> {
    const caller = requireUser(actor);
    if (!isAgronomist(caller)) {
      throw new ForbiddenException('Claiming escalation cases requires the agronomist role');
    }
    return this.telemetry.withSpan(
      'voice.escalation.claim',
      { 'case.id': caseId },
      async () => {
        const result = await this.cases.claim(caseId, caller.id, new Date().toISOString());
        if (!result.won) {
          throw new ConflictException(
            `Escalation case ${caseId} is already ${result.record.status}` +
              (result.record.assignedTo ? ` (assignee ${result.record.assignedTo})` : '')
          );
        }
        this.telemetry.increment('voice.escalations_total', 1, { status: 'assigned' });
        await this.events.publish(
          'voice.escalation.claimed',
          {
            caseId,
            sessionId: result.record.sessionId,
            assignedTo: caller.id,
            slaDueAt: result.record.slaDueAt,
            tenantId: this.tenantId()
          },
          caller.id
        );
        await this.audit.record({
          actorId: caller.id,
          action: 'voice.escalation_claimed',
          entityType: 'escalation_case',
          entityId: caseId,
          metadata: { sessionId: result.record.sessionId }
        });
        return { escalationCase: result.record };
      }
    );
  }

  /**
   * Records the agronomist's answer and pushes it to the farmer's channel.
   * Fail-closed honesty: when the channel does not confirm (stub driver,
   * provider error), the answer is recorded with delivery_status 'failed'
   * and the case STAYS 'assigned' for the retry sweep — it is never marked
   * answered-to-farmer until the channel confirms.
   */
  async answerCase(
    actor: User | null,
    caseId: string,
    input: { answerText: string }
  ): Promise<AnswerCaseResult> {
    const caller = requireUser(actor);
    if (!isAgronomist(caller)) {
      throw new ForbiddenException('Answering escalation cases requires the agronomist role');
    }
    const answerText = input.answerText?.trim() ?? '';
    if (!answerText) {
      throw new BadRequestException('answerText must not be empty');
    }
    return this.telemetry.withSpan(
      'voice.escalation.answer',
      { 'case.id': caseId },
      async () => {
        const current = await this.cases.getById(caseId);
        if (current.status !== 'assigned') {
          throw new ConflictException(
            `Escalation case ${caseId} is ${current.status}; answers require an assigned case`
          );
        }
        if (current.assignedTo !== caller.id && !caller.roles.includes('admin')) {
          throw new ForbiddenException('Only the assignee (or an admin) may answer this case');
        }
        const delivery = await this.dispatchAnswer(current, answerText);
        const updated = await this.cases.recordAnswerDelivery(caseId, {
          answerText,
          delivery: delivery.delivered ? 'delivered' : 'failed',
          deliveryNote: `${delivery.provider}/${delivery.driver}: ${delivery.note}`,
          at: new Date().toISOString()
        });
        if (delivery.delivered) {
          this.recordAnsweredTelemetry(updated);
          await this.events.publish(
            'voice.escalation.answered',
            {
              caseId,
              sessionId: updated.sessionId,
              answeredBy: caller.id,
              channel: updated.channel,
              tenantId: this.tenantId()
            },
            caller.id
          );
        }
        await this.audit.record({
          actorId: caller.id,
          action: 'voice.escalation_answered',
          entityType: 'escalation_case',
          entityId: caseId,
          metadata: {
            delivered: delivery.delivered,
            deliveryStatus: updated.deliveryStatus,
            attempts: updated.deliveryAttempts
          }
        });
        return { escalationCase: updated, delivery };
      }
    );
  }

  /** Pushes the rendered answer to the farmer's phone via the SMS driver. */
  private async dispatchAnswer(
    record: EscalationCaseRecord,
    answerText: string
  ): Promise<DeliveryResult> {
    try {
      return await this.integrations.deliver('sms', {
        to: record.phone,
        text: renderAnswerMessage(record, answerText)
      });
    } catch (error) {
      // Provider failure is an honest failed attempt, never a thrown 5xx
      // that loses the recorded answer — the sweep retries with backoff.
      return {
        delivered: false,
        provider: 'unknown',
        driver: 'stub',
        providerRef: `dispatch-error-${Date.now()}`,
        note: `Delivery attempt errored: ${(error as Error)?.message ?? error}`
      };
    }
  }

  /** Supervisor quality sampling on answered cases (1–5, optional close). */
  async scoreQuality(
    actor: User | null,
    caseId: string,
    input: { score: number; close?: boolean }
  ): Promise<{ escalationCase: EscalationCaseRecord }> {
    const caller = requireUser(actor);
    if (!isSupervisor(caller)) {
      throw new ForbiddenException('Quality sampling requires the supervisor role');
    }
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new BadRequestException('score must be an integer between 1 and 5');
    }
    const updated = await this.cases.recordQuality(caseId, {
      score: input.score,
      scoredBy: caller.id,
      at: new Date().toISOString(),
      close: input.close === true
    });
    await this.events.publish(
      'voice.escalation.quality_scored',
      {
        caseId,
        sessionId: updated.sessionId,
        score: input.score,
        scoredBy: caller.id,
        closed: input.close === true,
        tenantId: this.tenantId()
      },
      caller.id
    );
    await this.audit.record({
      actorId: caller.id,
      action: 'voice.escalation_quality_scored',
      entityType: 'escalation_case',
      entityId: caseId,
      metadata: { score: input.score }
    });
    return { escalationCase: updated };
  }

  // -- SLA reporting + sweeps ---------------------------------------------------

  /** Per-cohort SLA report (programme deliverable export). */
  async slaReport(actor: User | null, cohort?: string, now: Date = new Date()): Promise<SlaReport> {
    const caller = requireUser(actor);
    if (!isAgronomist(caller) && !isSupervisor(caller)) {
      throw new ForbiddenException('The SLA report requires the agronomist or supervisor role');
    }
    const cases = await this.cases.find(cohort ? { cohort } : {});
    const byStatus: Record<EscalationCaseStatus, number> = {
      queued: 0,
      assigned: 0,
      answered: 0,
      closed: 0
    };
    const durations: number[] = [];
    const scores: number[] = [];
    let breached = 0;
    for (const record of cases) {
      byStatus[record.status] += 1;
      const unresolved = record.status === 'queued' || record.status === 'assigned';
      if (record.slaBreachedAt || (unresolved && record.slaDueAt < now.toISOString())) {
        breached += 1;
      }
      if (record.answeredAt) {
        durations.push(
          (new Date(record.answeredAt).getTime() - new Date(record.createdAt).getTime()) / 60_000
        );
      }
      if (record.qualityScore !== undefined) {
        scores.push(record.qualityScore);
      }
    }
    durations.sort((a, b) => a - b);
    const average = (values: number[]): number | null =>
      values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
    return {
      ...(cohort ? { cohort } : {}),
      generatedAt: now.toISOString(),
      slaConfig: this.slaConfig(),
      totals: {
        cases: cases.length,
        byStatus,
        answered: byStatus.answered + byStatus.closed,
        breached,
        breachRate: cases.length > 0 ? breached / cases.length : 0
      },
      timeToAnswerMinutes: {
        samples: durations.length,
        average: average(durations),
        p50: percentile(durations, 50),
        max: durations.length > 0 ? durations[durations.length - 1] : null
      },
      quality: {
        samples: scores.length,
        averageScore: average(scores)
      }
    };
  }

  /**
   * One SLA/delivery sweep (the breacher). Follows the repo scheduler
   * doctrine: the API starts no timers — an external scheduler (cron/systemd
   * timer) invokes POST /api/agronomist/sla/sweep. Idempotent and safe to
   * invoke often:
   *  - flags un-answered cases past their business-hours deadline and emits
   *    voice.escalation.sla_breached exactly once per case;
   *  - retries failed answer deliveries (attempt-capped); a recovered
   *    delivery flips the case to 'answered' honestly.
   */
  async sweep(now: Date = new Date()): Promise<SlaSweepResult> {
    const result: SlaSweepResult = {
      breached: 0,
      deliveryRetried: 0,
      deliveryRecovered: 0,
      deliveryExhausted: 0
    };
    const nowIso = now.toISOString();
    for (const status of ['queued', 'assigned'] as const) {
      const overdue = await this.cases.find({
        status,
        slaDueAtOrBefore: nowIso,
        slaNotBreached: true
      });
      for (const record of overdue) {
        await this.cases.markSlaBreached(record.id, nowIso);
        result.breached += 1;
        this.telemetry.increment('voice.sla_breaches_total', 1, {
          status: record.status,
          priority: record.priority
        });
        await this.events.publish('voice.escalation.sla_breached', {
          caseId: record.id,
          sessionId: record.sessionId,
          status: record.status,
          slaDueAt: record.slaDueAt,
          ...(record.assignedTo ? { assignedTo: record.assignedTo } : {}),
          tenantId: this.tenantId()
        });
      }
    }
    const failed = await this.cases.find({ deliveryStatus: 'failed' });
    for (const record of failed) {
      if (!record.answerText || record.status !== 'assigned') {
        continue;
      }
      if (record.deliveryAttempts >= this.maxDeliveryAttempts()) {
        result.deliveryExhausted += 1;
        continue;
      }
      result.deliveryRetried += 1;
      const delivery = await this.dispatchAnswer(record, record.answerText);
      const updated = await this.cases.recordAnswerDelivery(record.id, {
        answerText: record.answerText,
        delivery: delivery.delivered ? 'delivered' : 'failed',
        deliveryNote: `${delivery.provider}/${delivery.driver}: ${delivery.note}`,
        at: nowIso
      });
      if (delivery.delivered) {
        result.deliveryRecovered += 1;
        this.recordAnsweredTelemetry(updated);
        await this.events.publish('voice.escalation.answered', {
          caseId: record.id,
          sessionId: record.sessionId,
          answeredBy: record.assignedTo ?? 'sweep',
          channel: record.channel,
          recovered: true,
          tenantId: this.tenantId()
        });
      }
    }
    return result;
  }

  /** The SLA metric itself: business-clock time-to-answer in minutes. */
  private recordAnsweredTelemetry(record: EscalationCaseRecord): void {
    this.telemetry.increment('voice.escalations_total', 1, { status: 'answered' });
    if (record.answeredAt) {
      const minutes =
        (new Date(record.answeredAt).getTime() - new Date(record.createdAt).getTime()) / 60_000;
      if (Number.isFinite(minutes) && minutes >= 0) {
        this.telemetry.record('voice.escalation_time_to_answer_minutes', minutes, {
          priority: record.priority
        });
      }
    }
  }
}
