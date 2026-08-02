import { describe, expect, it } from 'vitest';
import {
  evaluateDependencies,
  PgDependencyIndicator,
  RedisDependencyIndicator,
  type DependencyIndicator
} from './dependency-indicator.js';

function fake(overrides: Partial<DependencyIndicator>): DependencyIndicator {
  return {
    name: 'fake',
    configured: () => true,
    check: () => Promise.resolve(),
    ...overrides
  };
}

describe('evaluateDependencies', () => {
  it('reports a healthy configured dependency as up with latency', async () => {
    const [report] = await evaluateDependencies([fake({ name: 'database' })]);
    expect(report).toMatchObject({ name: 'database', status: 'up' });
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failing configured dependency as down', async () => {
    const [report] = await evaluateDependencies([
      fake({ check: () => Promise.reject(new Error('connection refused')) })
    ]);
    expect(report.status).toBe('down');
  });

  it('reports unconfigured dependencies as skipped without probing', async () => {
    let probed = false;
    const [report] = await evaluateDependencies([
      fake({
        configured: () => false,
        check: () => {
          probed = true;
          return Promise.resolve();
        }
      })
    ]);
    expect(report).toEqual({ name: 'fake', status: 'skipped', latencyMs: 0 });
    expect(probed).toBe(false);
  });

  it('times out slow probes as down', async () => {
    const [report] = await evaluateDependencies(
      [fake({ check: () => new Promise(() => {}) })],
      10
    );
    expect(report.status).toBe('down');
  });

  it('evaluates mixed registries independently', async () => {
    const reports = await evaluateDependencies([
      fake({ name: 'a' }),
      fake({ name: 'b', configured: () => false }),
      fake({ name: 'c', check: () => Promise.reject(new Error('x')) })
    ]);
    expect(reports.map((r) => r.status)).toEqual(['up', 'skipped', 'down']);
  });
});

describe('persistence indicators', () => {
  it('pg indicator is configured only with a pool', async () => {
    expect(new PgDependencyIndicator(null).configured()).toBe(false);
    const pool = { query: async (sql: string) => ({ rows: [{ '?column?': 1 }], sql }) };
    const indicator = new PgDependencyIndicator(pool as never);
    expect(indicator.configured()).toBe(true);
    await expect(indicator.check()).resolves.toBeUndefined();
  });

  it('redis indicator is configured only with a client', async () => {
    expect(new RedisDependencyIndicator(null).configured()).toBe(false);
    const client = { ping: async () => 'PONG' };
    const indicator = new RedisDependencyIndicator(client as never);
    expect(indicator.configured()).toBe(true);
    await expect(indicator.check()).resolves.toBeUndefined();
  });
});
