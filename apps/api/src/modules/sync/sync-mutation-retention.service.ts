import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { SYNC_MUTATION_REPOSITORY } from '../../database/persistence.tokens.js';
import type { SyncMutationRepository } from '../../database/repositories/sync.repository.js';

/** Default retention for recorded push outcomes (90 days). */
export const SYNC_MUTATIONS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Default in-process sweep cadence (1 hour). */
export const SYNC_MUTATIONS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Per-pass delete cap; large backlogs drain over successive passes. */
export const SYNC_MUTATIONS_SWEEP_BATCH_SIZE = 500;

/**
 * sync.mutations retention sweeper (L-09). The push idempotency ledger grows
 * one row per mutation per user forever unless pruned; outcomes older than
 * the retention window belong to clients that no longer replay, so pruning
 * cannot break dedup. The sweep itself is idempotent and batched.
 *
 * Driver: like the money-state sweepers, the in-process timer runs only
 * under SWEEPERS_ENABLED=true (single-process/preview deployments); deployed
 * environments may equally invoke sweep() from an external scheduler — the
 * method has no in-process state.
 */
@Injectable()
export class SyncMutationRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncMutationRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(SYNC_MUTATION_REPOSITORY) private readonly mutations: SyncMutationRepository,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** Deletes one batch of ledger rows older than the retention window. */
  async sweep(now: Date = new Date()): Promise<number> {
    const retentionMs = this.numberFrom('SYNC_MUTATIONS_RETENTION_MS', SYNC_MUTATIONS_RETENTION_MS);
    const batchSize = this.numberFrom('SYNC_MUTATIONS_SWEEP_BATCH_SIZE', SYNC_MUTATIONS_SWEEP_BATCH_SIZE);
    const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const pruned = await this.mutations.pruneOlderThan(cutoff, batchSize);
    if (pruned > 0) {
      this.logger.log(`sync.mutations retention: pruned ${pruned} row(s) older than ${cutoff}`);
    }
    return pruned;
  }

  onModuleInit(): void {
    if ((this.env.SWEEPERS_ENABLED ?? '').trim().toLowerCase() !== 'true') {
      return;
    }
    const intervalMs = this.numberFrom(
      'SYNC_MUTATIONS_SWEEP_INTERVAL_MS',
      SYNC_MUTATIONS_SWEEP_INTERVAL_MS
    );
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.warn(
          `sync.mutations retention sweep failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`sync.mutations retention sweeper enabled (every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private numberFrom(name: string, fallback: number): number {
    const parsed = Number(this.env[name] ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
