import { describe, expect, it, vi } from 'vitest';
import { evaluateDependencies } from './dependency-indicator.js';
import { TemporalWorkerIndicator } from './temporal-worker.indicator.js';

describe('TemporalWorkerIndicator (WP-G8)', () => {
  it('is not configured under the default stub driver (readiness unchanged)', async () => {
    const indicator = new TemporalWorkerIndicator({});
    expect(indicator.configured()).toBe(false);
    const probe = vi.fn();
    const withProbe = new TemporalWorkerIndicator({}, probe);
    const [report] = await evaluateDependencies([withProbe]);
    expect(report).toEqual({ name: 'temporal-worker', status: 'skipped', latencyMs: 0 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('is not configured for a case-insensitive stub selection', () => {
    expect(new TemporalWorkerIndicator({ WORKFLOW_DRIVER: 'STUB' }).configured()).toBe(false);
  });

  it('fails readiness when the temporal driver is selected but no worker polls the task queue', async () => {
    const probe = vi.fn().mockResolvedValue(0);
    const indicator = new TemporalWorkerIndicator(
      { WORKFLOW_DRIVER: 'temporal', TEMPORAL_ADDRESS: 'localhost:7233' },
      probe
    );
    expect(indicator.configured()).toBe(true);
    await expect(indicator.check()).rejects.toThrow(/no worker is polling task queue/);
    const [report] = await evaluateDependencies([indicator]);
    expect(report.status).toBe('down');
    expect(probe).toHaveBeenCalled();
  });

  it('passes when at least one worker polls the task queue', async () => {
    const indicator = new TemporalWorkerIndicator(
      { WORKFLOW_DRIVER: 'temporal', TEMPORAL_ADDRESS: 'localhost:7233' },
      vi.fn().mockResolvedValue(2)
    );
    await expect(indicator.check()).resolves.toBeUndefined();
    const [report] = await evaluateDependencies([indicator]);
    expect(report.status).toBe('up');
  });

  it('degrades readiness when the probe itself fails (server unreachable)', async () => {
    const indicator = new TemporalWorkerIndicator(
      { WORKFLOW_DRIVER: 'temporal', TEMPORAL_ADDRESS: 'localhost:7233' },
      vi.fn().mockRejectedValue(new Error('UNAVAILABLE: connection refused'))
    );
    const [report] = await evaluateDependencies([indicator]);
    expect(report.status).toBe('down');
  });

  it('mentions the configured task queue in the failure message', async () => {
    const indicator = new TemporalWorkerIndicator(
      {
        WORKFLOW_DRIVER: 'temporal',
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_TASK_QUEUE: 'custom-queue'
      },
      vi.fn().mockResolvedValue(0)
    );
    await expect(indicator.check()).rejects.toThrow(/'custom-queue'/);
  });
});
