import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createInMemoryOutboxRepository } from '../database/repositories/outbox.repository.js';
import { DomainEventsService } from '../core/domain-events.service.js';
import { OutboxSweeperService } from '../core/outbox-sweeper.service.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;
  let sweeper: OutboxSweeperService;

  beforeEach(() => {
    const events = new DomainEventsService(createInMemoryOutboxRepository());
    sweeper = new OutboxSweeperService(events, createInMemoryOutboxRepository());
  });

  it('liveness always answers ok', () => {
    controller = new HealthController(null, null, sweeper);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('readiness reports in-memory mode when no drivers are injected', async () => {
    controller = new HealthController(null, null, sweeper);
    const result = await controller.ready();
    expect(result.status).toBe('ok');
    expect(result.checks.postgres).toContain('in-memory');
    expect(result.checks.redis).toContain('in-memory');
    expect(result.outbox).toEqual({ pending: 0, deadLettered: 0 });
  });

  it('readiness fails with 503 when postgres is down', async () => {
    const pool = {
      query: async () => {
        throw new Error('connection refused');
      }
    } as unknown as pg.Pool;
    controller = new HealthController(pool, null, sweeper);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness fails with 503 when redis is down', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const redis = {
      ping: async () => {
        throw new Error('timeout');
      }
    };
    controller = new HealthController(pool, redis, sweeper);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('readiness answers ok with healthy drivers and reports the backlog', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    const redis = { ping: async () => 'PONG' };
    const outbox = createInMemoryOutboxRepository();
    const events = new DomainEventsService(outbox);
    await events.publish('health.check', {});
    sweeper = new OutboxSweeperService(events, outbox);
    controller = new HealthController(pool, redis, sweeper);
    const result = await controller.ready();
    expect(result.status).toBe('ok');
    expect(result.checks).toMatchObject({ postgres: 'up', redis: 'up' });
    expect(result.outbox.pending).toBe(1);
  });

  it('module status endpoint reflects driver wiring (admin diagnostics)', () => {
    controller = new HealthController(null, null, sweeper);
    expect(controller.modules()).toEqual({
      data: { persistence: 'in-memory', cache: 'in-memory', redisCircuit: 'closed' }
    });
  });
});
