import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { newId } from '../../common/async-repository.js';
import { FeatureFlagsService } from '../../common/feature-flags/feature-flags.service.js';
import { TelemetryService } from '../../common/telemetry/telemetry.service.js';
import { AuditService } from '../../core/audit.service.js';
import { DomainEventsService } from '../../core/domain-events.service.js';
import { EventDedupService } from '../../core/event-dedup.service.js';
import {
  AGENT_BANKING_AGENT_REPOSITORY,
  FRAUD_SENTINEL_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  OUTBOX_REPOSITORY
} from '../../database/persistence.tokens.js';
import type { AgentBankingAgentRepository } from '../../database/repositories/agent-banking.repository.js';
import type {
  FraudAlertCriteria,
  FraudAlertRecord,
  FraudCaseCriteria,
  FraudCaseRecord,
  FraudRuleRecord,
  FraudSentinelRepository
} from '../../database/repositories/fraud.repository.js';
import type { LedgerEntryRepository } from '../../database/repositories/ledger.repository.js';
import type { OutboxRepository } from '../../database/repositories/outbox.repository.js';
import {
  sentinelRuleDefinition,
  validateRuleParams,
  type AgentRuleContext,
  type LedgerEntryView,
  type RuleHit,
  type SentinelEventView,
  type SentinelRuleInput
} from './rules.js';

/** Feature flag gating the whole engine (defaults OFF — fail-closed). */
export const FLOAT_SENTINEL_FLAG = 'float-sentinel';

/**
 * Consumer name in events.processed_events — the sentinel's cursor. Mirrors
 * the analytics projector doctrine: the outbox published_at flag cannot serve
 * as the cursor (in-process fan-out marks rows published immediately).
 */
export const FRAUD_SENTINEL_CONSUMER = 'fraud.sentinel';

/**
 * Outbox events the sentinel evaluates. Money movement across every rail
 * (float, vouchers, escrow) posts through the single ledger, so one stream
 * suffices; finance.ledger.entry_posted additionally feeds the float-balance
 * rule via the referenced journal entries.
 */
export const SENTINEL_EVENT_NAMES = [
  'agentbank.transaction.posted',
  'agentbank.agent.registered',
  'agentbank.agent.limits_updated',
  'inputvouchers.voucher.redeemed',
  'finance.ledger.entry_posted'
] as const;

export interface SentinelRunResult {
  /** False when the rollout flag is off — nothing was evaluated or marked. */
  ran: boolean;
  reason?: string;
  /** Sentinel-relevant outbox events in the window. */
  relevant: number;
  /** Rules evaluated this pass. */
  rulesEvaluated: number;
  /** New alert rows created (dedup-key misses). */
  alertsCreated: number;
  /** Hits suppressed because their dedup key already existed (replay-safe). */
  alertsSuppressed: number;
  /** Rule evaluations that threw; each such rule version was disabled. */
  ruleErrors: number;
  /** Events newly marked processed for the consumer. */
  markedProcessed: number;
  ranAt: string;
}

/**
 * Float Sentinel (Stage 27) — deterministic fraud/liquidity anomaly engine.
 *
 * DETECTIVE CONTROL ONLY: the sentinel is strictly read-only on the ledger
 * and the outbox; it never blocks, delays, or alters money movement. Rule
 * firings become rows in the admin alert/case queue (fraud schema).
 *
 * Idempotency doctrine (mark-after, audit A4-7 — the analytics-projector
 * pattern): one pass evaluates ALL enabled rules over the FULL relevant
 * window (rules are pure functions of the stream, so re-evaluation yields
 * identical hits), upserts each hit by its dedup key
 * (rule_code:rule_version:firing_event_id:subject_type:subject_id — ON
 * CONFLICT DO NOTHING in pg), publishes fraud.alert.raised only for rows this
 * pass actually created, and only then marks the scanned events processed in
 * events.processed_events. A crash anywhere before the marking leaves the
 * events unprocessed and the next pass converges to the same rows.
 *
 * Fail-closed (spec §5): a throwing rule evaluation disables THAT rule
 * version (persisted) and counts fraud.rule_errors_total — the engine never
 * silently passes events through a broken rule, and one broken rule never
 * aborts the pass.
 *
 * There is deliberately no in-process timer: an external scheduler invokes
 * POST /api/v1/admin/fraud/sentinel/run (same convention as the analytics
 * projector's POST /api/v1/analytics/project).
 */
@Injectable()
export class FraudSentinelService {
  private readonly logger = new Logger(FraudSentinelService.name);

  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    private readonly dedup: EventDedupService,
    @Inject(FRAUD_SENTINEL_REPOSITORY) private readonly fraud: FraudSentinelRepository,
    @Inject(AGENT_BANKING_AGENT_REPOSITORY) private readonly agents: AgentBankingAgentRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerEntries: LedgerEntryRepository,
    private readonly events: DomainEventsService,
    private readonly flags: FeatureFlagsService,
    private readonly telemetry: TelemetryService,
    private readonly audit: AuditService
  ) {}

  /**
   * One evaluation pass over the outbox stream. Safe to invoke repeatedly
   * and after downtime; replays never double-alert.
   */
  async run(): Promise<SentinelRunResult> {
    const started = performance.now();
    if (!(await this.flags.isEnabled(FLOAT_SENTINEL_FLAG))) {
      return {
        ran: false,
        reason: `feature flag '${FLOAT_SENTINEL_FLAG}' is disabled`,
        relevant: 0,
        rulesEvaluated: 0,
        alertsCreated: 0,
        alertsSuppressed: 0,
        ruleErrors: 0,
        markedProcessed: 0,
        ranAt: new Date().toISOString()
      };
    }

    return this.telemetry.withSpan('fraud.sentinel.run', {}, async () => {
      const records = await this.outbox.listRecords();
      const relevantEvents: SentinelEventView[] = records
        .filter((record) =>
          (SENTINEL_EVENT_NAMES as readonly string[]).includes(record.event.name)
        )
        .map((record) => ({
          id: record.event.id,
          name: record.event.name,
          occurredAt: record.event.occurredAt,
          payload: record.event.payload as Record<string, unknown>
        }));

      const input: SentinelRuleInput = {
        events: relevantEvents,
        agents: await this.agentDirectory(),
        ledgerEntries: await this.ledgerEntryViews(relevantEvents)
      };

      const rules = await this.fraud.enabledRules();
      const hits: { rule: FraudRuleRecord; hit: RuleHit }[] = [];
      let ruleErrors = 0;
      for (const rule of rules) {
        const definition = sentinelRuleDefinition(rule.code);
        if (!definition) {
          // Unknown evaluator = misconfigured rule row. Fail closed exactly
          // like a throwing evaluation: disable the version, count it, move on.
          ruleErrors += 1;
          this.telemetry.increment('fraud.rule_errors_total', 1, {
            'fraud.rule_code': rule.code,
            'fraud.error': 'unknown_rule_code'
          });
          await this.fraud.setRuleEnabled(rule.code, rule.version, false);
          this.logger.error(
            `fraud rule '${rule.code}' v${rule.version} has no evaluator — disabled`
          );
          continue;
        }
        try {
          const ruleHits = await this.telemetry.withSpan(
            'fraud.sentinel.evaluate',
            { 'fraud.rule_code': rule.code, 'fraud.rule_version': rule.version },
            () => definition.evaluate(input, rule.params)
          );
          for (const hit of ruleHits) {
            hits.push({ rule, hit });
          }
        } catch (error) {
          // Fail closed: disable the broken rule VERSION so events are never
          // silently passed by it; the rest of the pass continues.
          ruleErrors += 1;
          this.telemetry.increment('fraud.rule_errors_total', 1, {
            'fraud.rule_code': rule.code
          });
          await this.fraud.setRuleEnabled(rule.code, rule.version, false);
          this.logger.error(
            `fraud rule '${rule.code}' v${rule.version} evaluation failed and was disabled: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // Deterministic ordering so replay publishes/upserts in a stable order.
      hits.sort(
        (a, b) =>
          a.hit.firingEventId.localeCompare(b.hit.firingEventId) ||
          a.rule.code.localeCompare(b.rule.code) ||
          a.hit.subjectId.localeCompare(b.hit.subjectId)
      );

      let alertsCreated = 0;
      let alertsSuppressed = 0;
      for (const { rule, hit } of hits) {
        const dedupKey = [
          rule.code,
          rule.version,
          hit.firingEventId,
          hit.subjectType,
          hit.subjectId
        ].join(':');
        const { alert, created } = await this.fraud.upsertAlert({
          id: newId('falert'),
          dedupKey,
          ruleCode: rule.code,
          ruleVersion: rule.version,
          subjectType: hit.subjectType,
          subjectId: hit.subjectId,
          severity: hit.severity,
          evidence: hit.evidence,
          createdAt: new Date().toISOString()
        });
        if (!created) {
          alertsSuppressed += 1;
          continue;
        }
        alertsCreated += 1;
        this.telemetry.increment('fraud.alerts_total', 1, {
          'fraud.rule_code': rule.code,
          'fraud.severity': alert.severity
        });
        await this.events.publish('fraud.alert.raised', {
          alertId: alert.id,
          ruleCode: alert.ruleCode,
          ruleVersion: alert.ruleVersion,
          severity: alert.severity,
          subjectType: alert.subjectType,
          subjectId: alert.subjectId,
          dedupKey
        });
      }

      // Mark-after (A4-7): only reached when evaluation + upserts completed;
      // a crash above leaves the events unprocessed and the next pass
      // converges via the dedup keys.
      let markedProcessed = 0;
      for (const event of relevantEvents) {
        if (await this.dedup.has(FRAUD_SENTINEL_CONSUMER, event.id)) {
          continue;
        }
        await this.dedup.mark(FRAUD_SENTINEL_CONSUMER, event.id);
        markedProcessed += 1;
      }
      this.telemetry.increment('fraud.eval_events_total', relevantEvents.length, {});
      this.telemetry.record('fraud.eval_latency_ms', performance.now() - started, {});

      const result: SentinelRunResult = {
        ran: true,
        relevant: relevantEvents.length,
        rulesEvaluated: rules.length - ruleErrors,
        alertsCreated,
        alertsSuppressed,
        ruleErrors,
        markedProcessed,
        ranAt: new Date().toISOString()
      };
      this.logger.log(
        `sentinel run: relevant=${result.relevant} rules=${result.rulesEvaluated} ` +
          `created=${alertsCreated} suppressed=${alertsSuppressed} ruleErrors=${ruleErrors} marked=${markedProcessed}`
      );
      return result;
    });
  }

  /** agentId → static rule context from the agent registry (read-only). */
  private async agentDirectory(): Promise<Map<string, AgentRuleContext>> {
    const agents = await this.agents.find({});
    const directory = new Map<string, AgentRuleContext>();
    for (const agent of agents) {
      directory.set(agent.id, {
        agentId: agent.id,
        dailyLimitKobo: agent.dailyLimitKobo,
        lowFloatThresholdKobo: agent.lowFloatThresholdKobo,
        floatAccountCode: agent.floatAccountCode
      });
    }
    return directory;
  }

  /** entryId → postings for every ledger event (projector-style rebuild). */
  private async ledgerEntryViews(
    events: readonly SentinelEventView[]
  ): Promise<Map<string, LedgerEntryView>> {
    const views = new Map<string, LedgerEntryView>();
    for (const event of events) {
      if (event.name !== 'finance.ledger.entry_posted') {
        continue;
      }
      const entryId = event.payload.entryId;
      if (typeof entryId !== 'string') {
        continue;
      }
      const entry = await this.ledgerEntries.findById(entryId);
      if (!entry) {
        this.logger.warn(
          `ledger entry ${entryId} for event ${event.id} not found; float-balance rule skips it`
        );
        continue;
      }
      views.set(entryId, {
        entryId,
        postings: entry.postings.map((posting) => ({
          accountCode: posting.accountCode,
          direction: posting.direction,
          amountKobo: posting.amountKobo
        }))
      });
    }
    return views;
  }

  // ------------------------------------------------------------------
  // Admin case-queue operations (controller surface; all audited).
  // ------------------------------------------------------------------

  async listAlerts(criteria: FraudAlertCriteria): Promise<FraudAlertRecord[]> {
    return this.fraud.findAlerts(criteria);
  }

  /** open → confirmed (guarded CAS; audited; publishes fraud.alert.confirmed). */
  async confirmAlert(id: string, actorId: string, resolution?: string): Promise<FraudAlertRecord> {
    const alert = await this.fraud.findAlertById(id);
    if (!alert) {
      throw new NotFoundException(`Fraud alert '${id}' not found`);
    }
    const updated = await this.fraud.transitionAlert(
      id,
      {
        status: 'confirmed',
        resolvedBy: actorId,
        resolvedAt: new Date().toISOString(),
        ...(resolution?.trim() ? { resolution: resolution.trim() } : {})
      },
      { status: 'open' }
    );
    await this.audit.record({
      actorId,
      action: 'fraud.alert.confirmed',
      entityType: 'fraud_alerts',
      entityId: id,
      metadata: { ruleCode: alert.ruleCode, ruleVersion: alert.ruleVersion }
    });
    await this.events.publish('fraud.alert.confirmed', {
      alertId: id,
      ruleCode: alert.ruleCode,
      ruleVersion: alert.ruleVersion
    }, actorId);
    return updated;
  }

  /** open → dismissed (guarded CAS; audited; publishes fraud.alert.dismissed). */
  async dismissAlert(id: string, actorId: string, reason: string): Promise<FraudAlertRecord> {
    if (!reason.trim()) {
      throw new BadRequestException('A dismissal reason is required');
    }
    const alert = await this.fraud.findAlertById(id);
    if (!alert) {
      throw new NotFoundException(`Fraud alert '${id}' not found`);
    }
    const updated = await this.fraud.transitionAlert(
      id,
      {
        status: 'dismissed',
        resolvedBy: actorId,
        resolvedAt: new Date().toISOString(),
        resolution: reason.trim()
      },
      { status: 'open' }
    );
    await this.audit.record({
      actorId,
      action: 'fraud.alert.dismissed',
      entityType: 'fraud_alerts',
      entityId: id,
      metadata: { ruleCode: alert.ruleCode, ruleVersion: alert.ruleVersion, reason: reason.trim() }
    });
    await this.events.publish('fraud.alert.dismissed', {
      alertId: id,
      ruleCode: alert.ruleCode,
      ruleVersion: alert.ruleVersion
    }, actorId);
    return updated;
  }

  /** Current-version rules with their all-time alert counts. */
  async listRules(): Promise<(FraudRuleRecord & { hitCount: number })[]> {
    const [rules, counts] = await Promise.all([
      this.fraud.listRules(),
      this.fraud.countAlertsByRule()
    ]);
    const currentByCode = new Map<string, FraudRuleRecord>();
    for (const rule of rules) {
      currentByCode.set(rule.code, rule); // ordered by version — last wins
    }
    return [...currentByCode.values()].map((rule) => ({
      ...rule,
      hitCount: counts[rule.code] ?? 0
    }));
  }

  /**
   * Creates the NEXT immutable version of a rule with merged params
   * (unspecified keys carry over from the current version). The previous
   * version is left untouched — every historical alert keeps naming the exact
   * parameter set that fired it. Audit-chained via AuditService (hash chain).
   */
  async updateRuleParams(
    code: string,
    params: Record<string, unknown>,
    actorId: string
  ): Promise<FraudRuleRecord> {
    const current = await this.fraud.currentRule(code);
    if (!current) {
      throw new NotFoundException(`Fraud rule '${code}' not found`);
    }
    let validated: Record<string, unknown>;
    try {
      validated = validateRuleParams(code, params);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const next = await this.fraud.insertRuleVersion({
      code,
      version: current.version + 1,
      description: current.description,
      params: { ...current.params, ...validated },
      enabled: current.enabled,
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId,
      action: 'fraud.rule.params_updated',
      entityType: 'fraud_rules',
      entityId: `${code}:${next.version}`,
      metadata: { previousVersion: current.version, params: next.params }
    });
    return next;
  }

  /** Individual rule kill-switch (the only mutable rule column; audited). */
  async setRuleEnabled(code: string, enabled: boolean, actorId: string): Promise<FraudRuleRecord> {
    const current = await this.fraud.currentRule(code);
    if (!current) {
      throw new NotFoundException(`Fraud rule '${code}' not found`);
    }
    const updated = await this.fraud.setRuleEnabled(code, current.version, enabled);
    if (!updated) {
      throw new ConflictException(`Fraud rule '${code}' v${current.version} could not be toggled`);
    }
    await this.audit.record({
      actorId,
      action: enabled ? 'fraud.rule.enabled' : 'fraud.rule.disabled',
      entityType: 'fraud_rules',
      entityId: `${code}:${current.version}`,
      metadata: { enabled }
    });
    return updated;
  }

  /** Groups alerts into an officer case. Every referenced alert must exist. */
  async createCase(alertIds: string[], assignee: string | undefined, actorId: string): Promise<FraudCaseRecord> {
    for (const alertId of alertIds) {
      if (!(await this.fraud.findAlertById(alertId))) {
        throw new NotFoundException(`Fraud alert '${alertId}' not found`);
      }
    }
    const record = await this.fraud.createCase({
      id: newId('fcase'),
      alertIds: [...new Set(alertIds)],
      ...(assignee?.trim() ? { assignee: assignee.trim() } : {}),
      status: 'open',
      createdBy: actorId,
      createdAt: new Date().toISOString()
    });
    await this.audit.record({
      actorId,
      action: 'fraud.case.created',
      entityType: 'fraud_cases',
      entityId: record.id,
      metadata: { alertIds: record.alertIds, ...(record.assignee ? { assignee: record.assignee } : {}) }
    });
    return record;
  }

  async listCases(criteria: FraudCaseCriteria): Promise<FraudCaseRecord[]> {
    return this.fraud.findCases(criteria);
  }

  /** open → resolved (guarded CAS; audited; publishes fraud.case.resolved). */
  async resolveCase(id: string, resolution: string, actorId: string): Promise<FraudCaseRecord> {
    if (!resolution.trim()) {
      throw new BadRequestException('A resolution is required');
    }
    const existing = await this.fraud.findCaseById(id);
    if (!existing) {
      throw new NotFoundException(`Fraud case '${id}' not found`);
    }
    const resolved = await this.fraud.resolveCase(
      id,
      { resolution: resolution.trim(), resolvedBy: actorId, resolvedAt: new Date().toISOString() },
      { status: 'open' }
    );
    await this.audit.record({
      actorId,
      action: 'fraud.case.resolved',
      entityType: 'fraud_cases',
      entityId: id,
      metadata: { alertIds: existing.alertIds, resolution: resolution.trim() }
    });
    await this.events.publish('fraud.case.resolved', {
      caseId: id,
      alertIds: existing.alertIds
    }, actorId);
    return resolved;
  }
}
