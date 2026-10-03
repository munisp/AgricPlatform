import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import {
  ENTITY_VERSION_REPOSITORY,
  SYNC_VERSION_BUMP_RETRY_REPOSITORY
} from '../../database/persistence.tokens.js';
import type {
  EntityVersionRepository,
  SyncVersionBumpRetryRepository
} from '../../database/repositories/sync.repository.js';

export interface SyncVersionChange {
  entity: string;
  entityId: string;
  /** Sync scope key (listing sellerId, notification userId, ...). */
  ownerId: string | null;
  actorId: string | null;
  deleted?: boolean;
}

/**
 * Version-bump hook for entity services (Wave SYNCSRV). Entity services call
 * recordChange() AFTER their primary write succeeds; the bump is additive
 * and deliberately non-fatal — a version-ledger failure must never break or
 * roll back the entity write itself (the ledger self-heals on the next
 * write; the gap is visible via /sync/status).
 *
 * No DB trigger exists for this (pgsql-ast-parser cannot parse CREATE
 * TRIGGER — see the design note in 024_sync.sql), so every write path that
 * should be sync-visible calls this hook explicitly.
 */
@Injectable()
export class SyncVersioningService {
  private readonly logger = new Logger(SyncVersioningService.name);

  constructor(
    @Inject(ENTITY_VERSION_REPOSITORY) private readonly versions: EntityVersionRepository,
    // Global metrics module; optional so bare unit constructions keep working.
    @Optional() private readonly metrics?: MetricsService,
    // GAP-M11: reconciliation ledger for failed bumps (migration 123).
    // Optional so bare unit constructions keep working; Nest injects the
    // configured driver via the token at runtime.
    @Optional()
    @Inject(SYNC_VERSION_BUMP_RETRY_REPOSITORY)
    private readonly retries?: SyncVersionBumpRetryRepository
  ) {}

  /**
   * Bumps sync.entity_versions for one record; never throws. A failure is
   * surfaced three ways: a WARN log, the
   * `agric_sync_version_bump_failures_total` Prometheus counter
   * (alertable), and — GAP-M11 — a compensating entry in
   * sync.version_bump_retries, so the reconciliation pass
   * (POST /admin/sweeps/sync-version-retries) re-applies the bump instead
   * of the write staying sync-invisible until the record changes again.
   * The enqueue itself is best-effort: if the ledger is down the retry
   * table is presumably down too, and the original failure must still not
   * break the entity write.
   */
  async recordChange(change: SyncVersionChange): Promise<void> {
    try {
      await this.versions.bump({
        entity: change.entity,
        entityId: change.entityId,
        ownerId: change.ownerId,
        updatedBy: change.actorId,
        deleted: change.deleted ?? false
      });
    } catch (error) {
      this.metrics?.recordSyncVersionBumpFailure(change.entity);
      this.logger.warn(
        `sync version bump failed for ${change.entity}/${change.entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      try {
        await this.retries?.enqueue(
          {
            entity: change.entity,
            entityId: change.entityId,
            ownerId: change.ownerId,
            actorId: change.actorId,
            deleted: change.deleted ?? false
          },
          error instanceof Error ? error.message : String(error)
        );
      } catch (enqueueError) {
        this.logger.error(
          `sync version bump retry enqueue failed for ${change.entity}/${change.entityId} — ` +
            `the write stays sync-invisible until the next write or a manual re-bump: ${
              enqueueError instanceof Error ? enqueueError.message : String(enqueueError)
            }`
        );
      }
    }
  }

  /**
   * GAP-M11 reconciliation pass: re-applies queued compensating bumps with
   * a bounded attempt budget (SYNC_VERSION_RETRY_MAX_ATTEMPTS). The bump is
   * the unconditional form, so re-application is safe — it only advances
   * the version, restoring /sync/pull visibility for the write that failed
   * to bump. Exhausted rows are KEPT (never silently dropped — a dropped
   * row is permanent sync invisibility) and surfaced via the result count
   * + ERROR log. Bounded by `limit` rows per pass; idempotent.
   */
  async reconcileFailedBumps(limit = 100): Promise<SyncVersionReconcileResult> {
    const result: SyncVersionReconcileResult = { retried: 0, recovered: 0, failed: 0, exhausted: 0 };
    if (!this.retries) {
      return result;
    }
    const pending = await this.retries.listPending(limit);
    for (const record of pending) {
      if (record.attempts >= SYNC_VERSION_RETRY_MAX_ATTEMPTS) {
        result.exhausted += 1;
        continue;
      }
      result.retried += 1;
      try {
        await this.versions.bump({
          entity: record.entity,
          entityId: record.entityId,
          ownerId: record.ownerId,
          updatedBy: record.actorId,
          deleted: record.deleted
        });
        await this.retries.remove(record.entity, record.entityId);
        result.recovered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = await this.retries.recordAttempt(record.entity, record.entityId, message);
        result.failed += 1;
        this.metrics?.recordSyncVersionBumpFailure(record.entity);
        if (attempts >= SYNC_VERSION_RETRY_MAX_ATTEMPTS) {
          result.exhausted += 1;
          this.logger.error(
            `sync version bump retry EXHAUSTED for ${record.entity}/${record.entityId} ` +
              `(${attempts} attempts) — row kept for ops inspection; the write is sync-invisible ` +
              `until a manual re-bump: ${message}`
          );
        } else {
          this.logger.warn(
            `sync version bump retry failed for ${record.entity}/${record.entityId} ` +
              `(attempt ${attempts}): ${message}`
          );
        }
      }
    }
    if (result.exhausted > 0) {
      this.logger.error(
        `sync version-bump reconciliation: ${result.exhausted} row(s) exhausted their retry ` +
          'budget and remain in sync.version_bump_retries for ops inspection'
      );
    }
    return result;
  }
}

/** Max compensating-bump attempts before a retry row is parked for ops. */
export const SYNC_VERSION_RETRY_MAX_ATTEMPTS = 8;

export interface SyncVersionReconcileResult {
  /** Rows a compensating bump was attempted for this pass. */
  retried: number;
  /** Rows successfully re-bumped and removed from the queue. */
  recovered: number;
  /** Rows whose re-bump failed again this pass. */
  failed: number;
  /** Rows at/over the attempt budget, kept for ops inspection. */
  exhausted: number;
}
