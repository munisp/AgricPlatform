import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../database/persistence.tokens.js';
import { OutboxSweeperService, type OutboxSweepResult } from './outbox-sweeper.service.js';

/** Default in-process cadence for the outbox relay (matches the CronJob minute). */
export const OUTBOX_RELAY_INTERVAL_MS = 60_000;
/** Upper bound for the startup jitter that de-correlates replica sweeps. */
export const OUTBOX_RELAY_MAX_JITTER_MS = 15_000;
/**
 * Advisory-lock key for the single-writer relay guard (pg advisory lock
 * namespace; arbitrary stable constant, 'ORLY' mnemonic).
 */
export const OUTBOX_RELAY_LOCK_KEY = 0x4f524c59;

/**
 * GAP-M03: the in-process outbox relay defaults ON — unlike the money-state
 * sweepers (SWEEPERS_ENABLED opt-in), a silent outbox is a data-stall, not
 * a convenience. The ONE production-safe exception: with NODE_ENV=production
 * and no explicit flag the timer stays OFF, because the backstop CronJob
 * (infra/k8s/cronjobs/outbox-relayer.yaml, part of the default kustomization
 * since GAP-M03) drives POST /admin/outbox/sweep there and N replicas each
 * running their own timer would only multiply advisory-lock contention.
 * Explicit flags win both ways: OUTBOX_RELAY_ENABLED=true|false.
 */
export function outboxRelayEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.OUTBOX_RELAY_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'true') {
    return true;
  }
  if (flag === 'false') {
    return false;
  }
  return (env.NODE_ENV ?? '').trim().toLowerCase() !== 'production';
}

function intervalFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * In-process scheduler for the outbox sweeper (GAP-M03), following the
 * SweeperSchedulerService setInterval pattern. Before this service the API
 * started no timers of its own, so without the (previously opt-in) CronJob
 * the relay silently stopped.
 *
 * Single-writer guard: when PostgreSQL is live, every pass runs under a
 * session-scoped pg advisory lock (pg_try_advisory_lock) so N API replicas
 * elect one sweeper per tick — a contending replica skips instead of
 * doubling the fan-out. In single-process/in-memory mode the in-process
 * `running` guard plays the same role. The sweep itself is idempotent
 * (backoff + attempts + consumer-side dedup via events.processed_events),
 * so a lock handover mid-crash converges on the next tick.
 *
 * Startup is jittered (uniform in [0, min(interval, 15s))) so a replica
 * fleet booted at once does not thundering-herd the lock on the same tick.
 */
@Injectable()
export class OutboxRelaySchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelaySchedulerService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  /** In-process overlap guard (single-process mode + reentrancy). */
  private running = false;

  constructor(
    private readonly sweeper: OutboxSweeperService,
    // PG_POOL is null in single-process/in-memory mode; the advisory lock
    // is skipped there and the in-process guard serializes passes.
    @Optional() @Inject(PG_POOL) private readonly pool: pg.Pool | null = null,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  onModuleInit(): void {
    if (!outboxRelayEnabled(this.env)) {
      this.logger.log(
        'in-process outbox relay disabled (OUTBOX_RELAY_ENABLED or production CronJob default)'
      );
      return;
    }
    const intervalMs = intervalFrom(this.env, 'OUTBOX_RELAY_INTERVAL_MS', OUTBOX_RELAY_INTERVAL_MS);
    const tick = () => {
      void this.sweepOnce().catch((error: unknown) =>
        this.logger.warn(
          `scheduled outbox sweep failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    };
    const jitterMs = Math.floor(
      Math.random() * Math.min(intervalMs, OUTBOX_RELAY_MAX_JITTER_MS)
    );
    this.timers.push(
      setTimeout(() => {
        tick();
        const interval = setInterval(tick, intervalMs);
        interval.unref?.();
        this.timers.push(interval);
      }, jitterMs)
    );
    for (const timer of this.timers) {
      timer.unref?.();
    }
    this.logger.log(
      `in-process outbox relay enabled (every ${intervalMs}ms, first pass in ~${jitterMs}ms)`
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.length = 0;
  }

  /**
   * One guarded sweep pass. Returns the sweep result, or 'skipped' when
   * another writer holds the relay (same-process overlap or a peer replica
   * holding the pg advisory lock). Lock/unlock failures propagate to the
   * caller (the scheduler tick logs them) — a sweep without its guard is
   * never run half-protected.
   */
  async sweepOnce(now: Date = new Date()): Promise<OutboxSweepResult | 'skipped'> {
    if (this.running) {
      return 'skipped';
    }
    this.running = true;
    try {
      if (!this.pool) {
        return await this.sweeper.sweep(now);
      }
      const client = await this.pool.connect();
      try {
        const locked = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [OUTBOX_RELAY_LOCK_KEY]
        );
        if (!locked.rows[0]?.locked) {
          return 'skipped';
        }
        try {
          return await this.sweeper.sweep(now);
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [OUTBOX_RELAY_LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    } finally {
      this.running = false;
    }
  }
}
