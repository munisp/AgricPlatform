import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { AuditService } from '../../core/audit.service.js';
import {
  COMPLIANCE_CONSENT_REPOSITORY,
  DATA_SUBJECT_REQUEST_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  RETENTION_POLICY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  ComplianceConsentRepository,
  DataSubjectRequestRepository,
  RetentionPolicy,
  RetentionPolicyRepository
} from '../../database/repositories/compliance.repository.js';
import type { NotificationRepository } from '../../database/repositories/notification.repository.js';
import { pseudonymFor } from './compliance.service.js';

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
 * Unknown entities are reported as `skipped` (never silently ignored).
 *
 * anonymize_not_delete = true pseudonymises the user reference (deterministic
 * salted tombstone, same function as erasure); false hard-deletes the rows.
 * Financial/ledger/audit rows are NEVER in scope — legal hold.
 */
@Injectable()
export class ComplianceRetentionService {
  constructor(
    private readonly audit: AuditService,
    @Inject(RETENTION_POLICY_REPOSITORY) private readonly policies: RetentionPolicyRepository,
    @Inject(COMPLIANCE_CONSENT_REPOSITORY)
    private readonly consents: ComplianceConsentRepository,
    @Inject(DATA_SUBJECT_REQUEST_REPOSITORY)
    private readonly dsr: DataSubjectRequestRepository,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository
  ) {}

  async listPolicies(): Promise<RetentionPolicy[]> {
    return this.policies.list();
  }

  async upsertPolicy(
    actor: User | null,
    input: { entity: string; retainDays: number; anonymizeNotDelete: boolean }
  ): Promise<RetentionPolicy> {
    this.requireAdmin(actor);
    const policy: RetentionPolicy = { ...input, updatedAt: new Date().toISOString() };
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
