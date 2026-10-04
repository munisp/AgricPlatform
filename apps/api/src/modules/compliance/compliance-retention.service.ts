import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, Optional, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import {
  COMPLIANCE_CONSENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  INBOUND_EVENT_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  OUTBOX_REPOSITORY,
  PROCESSED_EVENT_REPOSITORY,
  RETENTION_POLICY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ComplianceConsentRepository,
  DataSubjectRequestRepository,
  RetentionPolicy,
  RetentionPolicyRepository
} from '../../database/repositories/compliance.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import {
  InMemoryInboundEventRepository,
  type InboundEventRepository
} from '../../database/repositories/phase3.repository.js';
import {
  InMemoryOutboxRepository,
  type OutboxRepository
} from '../../database/repositories/outbox.repository.js';
import {
  InMemoryProcessedEventRepository,
  type ProcessedEventRepository
} from '../../database/repositories/processed-event.repository.js';
import { pseudonymFor } from './compliance.service.js';

/**
 * GAP-L11: default per-statement delete cap for the events.processed_events
 * purge (aligned with the sync.mutations idempotency-ledger sweeper,
 * SYNC_MUTATIONS_SWEEP_BATCH_SIZE). Overridable via
 * PROCESSED_EVENTS_PURGE_BATCH_SIZE.
 */
export const PROCESSED_EVENTS_PURGE_BATCH_SIZE = 500;

/** Positive integer env override, falling back when unset/invalid. */
function positiveIntFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name] ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface RetentionSweepOptions {
  /**
   * true (the default) = count only, no mutations. Pass an explicit
   * { dryRun: false } to execute anonymisation/purge.
   */
  dryRun?: boolean;
}

export type RetentionAction = 'anonymize' | 'purge' | 'skipped';

export interface RetentionEntityResult {
  entity: string;
  retainDays: number;
  /** Rows past the retention window. */
  matched: number;
  action: RetentionAction;
  /** Rows actually anonymised/purged (0 when dryRun). */
  affected: number;
  note?: string;
}

export interface RetentionSweepResult {
  ranAt: string;
  dryRun: boolean;
  policies: number;
  results: RetentionEntityResult[];
  totals: { matched: number; affected: number; skipped: number };
}

/**
 * Endpoint-driven retention sweeper (Wave COMP), following the
 * scripts/sweep-outbox.mjs philosophy: the API starts no timers — an
 * external scheduler invokes POST /compliance/retention/sweep (documented
 * cron in docs/compliance/retention-policy.md), always defaulting to a
 * dry run unless the caller passes an explicit { dryRun: false }.
 *
 * Supported entity keys:
 *   compliance.consent_records        revoked consents past retain_days
 *   compliance.data_subject_requests  closed DSRs past retain_days
 *   notifications.messages            notifications past retain_days
 *   integrations.inbound_events       processed inbound webhook rows past retain_days (V-27)
 *   events.outbox                     published outbox rows past retain_days (V-27)
 *   events.outbox_dead_letters        dead-lettered outbox rows past retain_days (GAP-M20)
 *   events.processed_events           consumer-dedupe markers past retain_days (GAP-L11)
 * Unknown entities are reported as `skipped` (never silently ignored).
 *
 * anonymize_not_delete = true pseudonymises the user reference (deterministic
 * salted tombstone, same function as erasure); false hard-deletes the rows.
 * For the two event-ledger entities (V-27) there is no user reference to
 * pseudonymise — the PII sits in the payload — so anonymise scrubs the
 * payload to an empty-object tombstone (both columns are jsonb NOT NULL,
 * so NULL is not an option) and keeps the row metadata as the audit trail.
 * Financial/ledger/audit rows are NEVER in scope — legal hold.
 */
@Injectable()
export class ComplianceRetentionService {
  private readonly logger = new Logger(ComplianceRetentionService.name);

  constructor(
    private readonly audit: AuditService,
    @Inject(RETENTION_POLICY_REPOSITORY) private readonly policies: RetentionPolicyRepository,
    @Inject(COMPLIANCE_CONSENT_REPOSITORY)
    private readonly consents: ComplianceConsentRepository,
    @Inject(DATA_SUBJECT_REQUEST_REPOSITORY)
    private readonly dsr: DataSubjectRequestRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    // V-27: appended last with in-memory defaults so existing positional
    // constructor calls (unit specs) keep working unchanged; Nest injects
    // the configured drivers via the tokens at runtime.
    @Optional()
    @Inject(INBOUND_EVENT_REPOSITORY)
    private readonly inboundEvents: InboundEventRepository = new InMemoryInboundEventRepository(),
    @Optional()
    @Inject(OUTBOX_REPOSITORY)
    private readonly outbox: OutboxRepository = new InMemoryOutboxRepository(),
    // GAP-L11: appended last with in-memory defaults so existing positional
    // constructor calls (unit specs) keep working unchanged; Nest injects
    // the configured driver via the token at runtime.
    @Optional()
    @Inject(PROCESSED_EVENT_REPOSITORY)
    private readonly processedEvents: ProcessedEventRepository = new InMemoryProcessedEventRepository(),
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async listPolicies(): Promise<RetentionPolicy[]> {
    return this.policies.list();
  }

  async upsertPolicy(
    actor: User | null,
    input: { entity: string; retainDays: number; anonymizeNotDelete: boolean }
  ): Promise<RetentionPolicy> {
    this.requireAdmin(actor);
    // V-74: never spread caller input into persistence — the body is
    // interface-typed, so unknown fields would otherwise land verbatim in
    // the stored policy row (mass-assignment sink). Pick fields explicitly.
    if (!Number.isSafeInteger(input.retainDays) || input.retainDays < 1) {
      throw new BadRequestException('retainDays must be a positive integer (days)');
    }
    if (typeof input.entity !== 'string' || input.entity.length === 0 || input.entity.length > 200) {
      throw new BadRequestException('entity must be a non-empty string (max 200 chars)');
    }
    const policy: RetentionPolicy = {
      entity: input.entity,
      retainDays: input.retainDays,
      anonymizeNotDelete: input.anonymizeNotDelete === true,
      updatedAt: new Date().toISOString()
    };
    const saved = await this.policies.upsert(policy);
    await this.audit.record({
      actorId: actor!.id,
      action: 'compliance.retention_policy_updated',
      entityType: 'retention_policy',
      entityId: input.entity,
      metadata: { retainDays: input.retainDays, anonymizeNotDelete: input.anonymizeNotDelete }
    });
    return saved;
  }

  async sweep(actor: User | null, options: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
    this.requireAdmin(actor);
    const dryRun = options.dryRun ?? true;
    const policies = await this.policies.list();
    const results: RetentionEntityResult[] = [];
    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.retainDays * 86_400_000).toISOString();
      results.push(await this.sweepEntity(policy, cutoff, dryRun));
    }
    const totals = {
      matched: results.reduce((sum, r) => sum + r.matched, 0),
      affected: results.reduce((sum, r) => sum + r.affected, 0),
      skipped: results.filter((r) => r.action === 'skipped').length
    };
    await this.audit.record({
      actorId: actor!.id,
      action: dryRun ? 'compliance.retention_sweep_dry_run' : 'compliance.retention_sweep_executed',
      entityType: 'retention_sweep',
      entityId: 'sweep',
      metadata: { dryRun, totals }
    });
    return { ranAt: new Date().toISOString(), dryRun, policies: policies.length, results, totals };
  }

  private async sweepEntity(
    policy: RetentionPolicy,
    cutoff: string,
    dryRun: boolean
  ): Promise<RetentionEntityResult> {
    const base = { entity: policy.entity, retainDays: policy.retainDays };
    switch (policy.entity) {
      case 'compliance.consent_records': {
        const matched = await this.consents.countRevokedBefore(cutoff);
        const affected = dryRun
          ? 0
          : policy.anonymizeNotDelete
            ? await this.consents.anonymizeRevokedBefore(cutoff, pseudonymFor)
            : await this.consents.purgeRevokedBefore(cutoff);
        return { ...base, matched, action: policy.anonymizeNotDelete ? 'anonymize' : 'purge', affected };
      }
      case 'compliance.data_subject_requests': {
        const matched = await this.dsr.countClosedBefore(cutoff);
        const affected = dryRun
          ? 0
          : policy.anonymizeNotDelete
            ? await this.dsr.anonymizeClosedBefore(cutoff, pseudonymFor)
            : await this.dsr.purgeClosedBefore(cutoff);
        return { ...base, matched, action: policy.anonymizeNotDelete ? 'anonymize' : 'purge', affected };
      }
      case 'notifications.messages': {
        // NotificationCriteria has no createdBefore filter, so the sweeper
        // scans through the port's all() — acceptable for a scheduled
        // maintenance pass; flagged here for honesty.
        const expired = (await this.notifications.all()).filter(
          (message) => message.createdAt < cutoff
        );
        let affected = 0;
        if (!dryRun) {
          for (const message of expired) {
            if (policy.anonymizeNotDelete) {
              await this.notifications.update(message.id, { userId: pseudonymFor(message.userId) });
            } else {
              await this.notifications.remove(message.id);
            }
            affected += 1;
          }
        }
        return {
          ...base,
          matched: expired.length,
          action: policy.anonymizeNotDelete ? 'anonymize' : 'purge',
          affected,
          note: 'matched via full scan — NotificationCriteria exposes no createdBefore filter'
        };
      }
      case 'integrations.inbound_events': {
        // V-27: processed inbound webhook payloads carry partner/provider
        // PII. anonymize_not_delete=true keeps the row metadata (system,
        // dedupe key, received/processed timestamps — the processing audit
        // trail) and scrubs only the payload to an empty-object tombstone
        // (the column is jsonb NOT NULL, so NULL is not an option);
        // false hard-deletes the whole row.
        const matched = await this.inboundEvents.countProcessedBefore(cutoff);
        const affected = dryRun
          ? 0
          : policy.anonymizeNotDelete
            ? await this.inboundEvents.anonymizeProcessedBefore(cutoff)
            : await this.inboundEvents.purgeProcessedBefore(cutoff);
        return { ...base, matched, action: policy.anonymizeNotDelete ? 'anonymize' : 'purge', affected };
      }
      case 'events.outbox': {
        // V-27: published outbox rows are relay history; the default policy
        // prunes them (anonymize_not_delete=false). If an operator flips the
        // policy to anonymize, the payload is tombstoned to '{}' (jsonb NOT
        // NULL — never NULL) and the event metadata survives for debugging.
        const matched = await this.outbox.countPublishedBefore(cutoff);
        const affected = dryRun
          ? 0
          : policy.anonymizeNotDelete
            ? await this.outbox.anonymizePublishedBefore(cutoff)
            : await this.outbox.purgePublishedBefore(cutoff);
        return { ...base, matched, action: policy.anonymizeNotDelete ? 'anonymize' : 'purge', affected };
      }
      case 'events.outbox_dead_letters': {
        // GAP-M20: dead-lettered rows keep published_at NULL forever, so the
        // published-row filters above never match them — without this
        // handler their full payloads (potentially PII) accumulate without
        // bound. Keyed on dead_lettered_at. The purge path anonymizes the
        // payload FIRST (empty-object tombstone, jsonb NOT NULL) and only
        // then deletes, so a mid-sweep crash never leaves unscrubbed PII
        // behind on rows it already decided to remove; anonymize_not_delete
        // keeps the tombstoned row metadata for redrive forensics.
        const matched = await this.outbox.countDeadLetteredBefore(cutoff);
        if (dryRun) {
          return { ...base, matched, action: policy.anonymizeNotDelete ? 'anonymize' : 'purge', affected: 0 };
        }
        if (policy.anonymizeNotDelete) {
          const affected = await this.outbox.anonymizeDeadLetteredBefore(cutoff);
          return { ...base, matched, action: 'anonymize', affected };
        }
        await this.outbox.anonymizeDeadLetteredBefore(cutoff);
        const affected = await this.outbox.purgeDeadLetteredBefore(cutoff);
        return {
          ...base,
          matched,
          action: 'purge',
          affected,
          note: 'payloads anonymized (tombstoned) before purge'
        };
      }
      case 'events.processed_events': {
        // GAP-L11: consumer-side idempotency ledger (consumer, event_id,
        // processed_at). Rows are pure dedupe markers — no payload, no PII —
        // so there is nothing to anonymize; past the window they are simply
        // hard-purged (anonymize_not_delete has no effect here). The window
        // comes from the policy row (90-day default, aligned with
        // events.outbox: once the outbox row itself is pruned, its dedupe
        // marker can never be consulted again) and can be overridden via
        // PROCESSED_EVENTS_RETENTION_DAYS. The purge is batched
        // (PROCESSED_EVENTS_PURGE_BATCH_SIZE) so one statement never locks
        // the whole ledger, and fail-closed: a failing count/purge is
        // logged and surfaced in the result note WITHOUT rejecting the
        // sweep, so a failing purge cannot take down the sweeper loop —
        // batches already committed stay committed (the delete is
        // idempotent; the next pass re-drives the remainder).
        const retainDays = positiveIntFrom(this.env, 'PROCESSED_EVENTS_RETENTION_DAYS', policy.retainDays);
        const entityBase = { entity: policy.entity, retainDays };
        const entityCutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();
        let matched = 0;
        let affected = 0;
        try {
          matched = await this.processedEvents.countProcessedBefore(entityCutoff);
          if (!dryRun) {
            const batchSize = positiveIntFrom(
              this.env,
              'PROCESSED_EVENTS_PURGE_BATCH_SIZE',
              PROCESSED_EVENTS_PURGE_BATCH_SIZE
            );
            for (;;) {
              const batch = await this.processedEvents.purgeProcessedBefore(entityCutoff, batchSize);
              affected += batch;
              if (batch < batchSize) {
                break;
              }
            }
            if (affected > 0) {
              this.logger.log(
                `events.processed_events retention: purged ${affected} row(s) older than ${entityCutoff}`
              );
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`events.processed_events retention purge failed: ${message}`);
          return { ...entityBase, matched, action: 'purge', affected, note: `purge failed: ${message}` };
        }
        return {
          ...entityBase,
          matched,
          action: 'purge',
          affected,
          ...(policy.anonymizeNotDelete
            ? { note: 'no payload columns to anonymize — dedupe markers are purge-only' }
            : {})
        };
      }
      default:
        return {
          ...base,
          matched: 0,
          action: 'skipped',
          affected: 0,
          note: `no retention handler registered for entity '${policy.entity}'`
        };
    }
  }

  private requireAdmin(actor: User | null): void {
    if (!actor) {
      throw new UnauthorizedException('Authentication required for this resource');
    }
    if (!actor.roles.includes('admin')) {
      throw new ForbiddenException('Administrator role required');
    }
  }
}
