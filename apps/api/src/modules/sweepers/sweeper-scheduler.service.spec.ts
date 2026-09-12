import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EscrowExpirySweeperService } from './escrow-expiry-sweeper.service.js';
import { SweeperSchedulerService, sweepersEnabled } from './sweeper-scheduler.service.js';
import type { VoucherStuckSweeperService } from './voucher-stuck-sweeper.service.js';

function makeScheduler(env: NodeJS.ProcessEnv) {
  const escrowSweep = vi.fn().mockResolvedValue({ scanned: 0 });
  const voucherSweep = vi.fn().mockResolvedValue({ scanned: 0 });
  const scheduler = new SweeperSchedulerService(
    { sweep: escrowSweep } as unknown as EscrowExpirySweeperService,
    { sweep: voucherSweep } as unknown as VoucherStuckSweeperService,
    env
  );
  return { scheduler, escrowSweep, voucherSweep };
}

describe('SweeperSchedulerService (WP-G12)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweepersEnabled is opt-in only (explicit true)', () => {
    expect(sweepersEnabled({})).toBe(false);
    expect(sweepersEnabled({ SWEEPERS_ENABLED: 'false' })).toBe(false);
    expect(sweepersEnabled({ SWEEPERS_ENABLED: '1' })).toBe(false);
    expect(sweepersEnabled({ SWEEPERS_ENABLED: 'true' })).toBe(true);
    expect(sweepersEnabled({ SWEEPERS_ENABLED: ' TRUE ' })).toBe(true);
  });

  it('starts no timers unless SWEEPERS_ENABLED=true', () => {
    vi.useFakeTimers();
    const { scheduler, escrowSweep, voucherSweep } = makeScheduler({});
    scheduler.onModuleInit();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(escrowSweep).not.toHaveBeenCalled();
    expect(voucherSweep).not.toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('runs both sweepers on their configured intervals when enabled', async () => {
    vi.useFakeTimers();
    const { scheduler, escrowSweep, voucherSweep } = makeScheduler({
      SWEEPERS_ENABLED: 'true',
      SWEEP_ESCROW_EXPIRY_INTERVAL_MS: '60000',
      SWEEP_VOUCHER_STUCK_INTERVAL_MS: '120000'
    });
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(escrowSweep).toHaveBeenCalledTimes(1);
    expect(voucherSweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(escrowSweep).toHaveBeenCalledTimes(2);
    expect(voucherSweep).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(escrowSweep).toHaveBeenCalledTimes(2);
    expect(voucherSweep).toHaveBeenCalledTimes(1);
  });

  it('a throwing sweep is logged, never crashes the scheduler loop', async () => {
    vi.useFakeTimers();
    const { scheduler, escrowSweep } = makeScheduler({
      SWEEPERS_ENABLED: 'true',
      SWEEP_ESCROW_EXPIRY_INTERVAL_MS: '1000'
    });
    escrowSweep.mockRejectedValueOnce(new Error('db down'));
    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(3_000);
    // The rejected pass did not kill the interval: three fires happened.
    expect(escrowSweep).toHaveBeenCalledTimes(3);
    scheduler.onModuleDestroy();
  });
});
