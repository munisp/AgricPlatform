import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EscrowExpirySweeperService } from './escrow-expiry-sweeper.service.js';
import { VoucherStuckSweeperService, VOUCHER_STUCK_TTL_MS } from './voucher-stuck-sweeper.service.js';

/** Default in-process cadence for the money-state sweepers (5 minutes). */
export const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;

/** Default per-pass batch cap for both sweepers. */
export const SWEEPER_BATCH_SIZE = 100;

/** True only on an explicit opt-in: SWEEPERS_ENABLED=true. */
export function sweepersEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.SWEEPERS_ENABLED ?? '').trim().toLowerCase() === 'true';
}

function intervalFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * In-process scheduler for the money-state sweepers (WP-G12), following the
 * IVR/USSD setInterval pattern. OFF unless SWEEPERS_ENABLED=true — the
 * primary driver in deployed environments is the Kubernetes CronJob fleet
 * (infra/k8s/cronjobs/) invoking the admin sweep endpoints; the in-process
 * timers exist for single-process/preview deployments without a cron
 * facility. Per-sweeper intervals and the batch cap are env-tunable:
 *   SWEEP_ESCROW_EXPIRY_INTERVAL_MS   (default 300000)
 *   SWEEP_VOUCHER_STUCK_INTERVAL_MS   (default 300000)
 *   SWEEP_VOUCHER_STUCK_TTL_MS        (default 3600000)
 *   SWEEP_BATCH_SIZE                  (default 100)
 * Both sweepers are idempotent and CAS-guarded, so overlapping in-process
 * and CronJob-driven passes are safe (a double-run is a no-op).
 */
@Injectable()
export class SweeperSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SweeperSchedulerService.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly escrowExpiry: EscrowExpirySweeperService,
    private readonly voucherStuck: VoucherStuckSweeperService,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  onModuleInit(): void {
    if (!sweepersEnabled(this.env)) {
      return;
    }
    const batchSize = intervalFrom(this.env, 'SWEEP_BATCH_SIZE', SWEEPER_BATCH_SIZE);
    const escrowMs = intervalFrom(this.env, 'SWEEP_ESCROW_EXPIRY_INTERVAL_MS', SWEEPER_INTERVAL_MS);
    const voucherMs = intervalFrom(this.env, 'SWEEP_VOUCHER_STUCK_INTERVAL_MS', SWEEPER_INTERVAL_MS);
    const stuckTtlMs = intervalFrom(this.env, 'SWEEP_VOUCHER_STUCK_TTL_MS', VOUCHER_STUCK_TTL_MS);
    this.timers.push(
      setInterval(() => {
        void this.escrowExpiry.sweep(new Date(), batchSize).catch((error: unknown) =>
          this.logger.warn(
            `escrow expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }, escrowMs),
      setInterval(() => {
        void this.voucherStuck
          .sweep(new Date(), { batchSize, stuckTtlMs })
          .catch((error: unknown) =>
            this.logger.warn(
              `voucher stuck sweep failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      }, voucherMs)
    );
    for (const timer of this.timers) {
      timer.unref?.();
    }
    this.logger.log(
      `money-state sweepers enabled (escrow every ${escrowMs}ms, voucher every ${voucherMs}ms, batch ${batchSize})`
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
  }
}
