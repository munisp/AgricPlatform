import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import {
  DELIVERY_LOG_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PG_POOL,
  REDIS_CLIENT
} from '../database/persistence.tokens.js';
import type { DeliveryLogRepository } from '../database/repositories/delivery-log.repository.js';
import type { NotificationRepository } from '../database/repositories/notification.repository.js';
import { FeatureFlagsService } from '../common/feature-flags/feature-flags.service.js';
import { OutboxSweeperService } from '../core/outbox-sweeper.service.js';
import { IntegrationsService } from '../modules/integrations/integrations.service.js';

export type ModuleReadiness = 'up' | 'down' | 'disabled';

export interface ModuleProbe {
  name: string;
  status: ModuleReadiness;
  /** Cheap probe details (counts, driver names) — never payloads. */
  details?: Record<string, unknown>;
  error?: string;
}

export interface ModuleHealthReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  modules: ModuleProbe[];
}

/**
 * Per-module readiness matrix (Wave P; observability plan §A.5 extension).
 * Cheap probes only: connectivity pings and backlog counters — no payload
 * scans. A failing probe degrades the report but never throws, so operators
 * always get the full matrix.
 */
@Injectable()
export class ModuleHealthService {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly outboxSweeper: OutboxSweeperService,
    private readonly flags: FeatureFlagsService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly messages: NotificationRepository,
    @Inject(DELIVERY_LOG_REPOSITORY) private readonly deliveryLog: DeliveryLogRepository,
    @Optional() @Inject(PG_POOL) private readonly pool: pg.Pool | null = null,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null
  ) {}

  async report(): Promise<ModuleHealthReport> {
    const modules = await Promise.all([
      this.probe('database', () => this.probeDatabase()),
      this.probe('cache', () => this.probeRedis()),
      this.probe('outbox', () => this.probeOutbox()),
      this.probe('notifications', () => this.probeNotifications()),
      this.probe('integrations', () => this.probeIntegrations()),
      this.probe('feature-flags', () => this.probeFlags())
    ]);
    return {
      status: modules.some((module) => module.status === 'down') ? 'degraded' : 'ok',
      checkedAt: new Date().toISOString(),
      modules
    };
  }

  private async probe(name: string, run: () => Promise<ModuleProbe>): Promise<ModuleProbe> {
    try {
      return await run();
    } catch (error) {
      return { name, status: 'down', error: (error as Error).message };
    }
  }

  private async probeDatabase(): Promise<ModuleProbe> {
    if (!this.pool) {
      return { name: 'database', status: 'disabled', details: { mode: 'in-memory' } };
    }
    await this.pool.query('SELECT 1');
    return { name: 'database', status: 'up', details: { mode: 'postgres' } };
  }

  private async probeRedis(): Promise<ModuleProbe> {
    if (!this.redis) {
      return { name: 'cache', status: 'disabled', details: { mode: 'in-memory' } };
    }
    await this.redis.ping();
    return { name: 'cache', status: 'up', details: { mode: 'redis' } };
  }

  private async probeOutbox(): Promise<ModuleProbe> {
    const backlog = await this.outboxSweeper.backlog();
    return {
      name: 'outbox',
      status: backlog.deadLettered > 0 ? 'down' : 'up',
      details: backlog
    };
  }

  private async probeNotifications(): Promise<ModuleProbe> {
    const queued = (await this.messages.find({ status: 'queued' })).length;
    const deadLetters = (await this.deliveryLog.list()).filter((entry) => entry.deadLetteredAt).length;
    return {
      name: 'notifications',
      status: deadLetters > 0 ? 'down' : 'up',
      details: { queued, deadLetters }
    };
  }

  private async probeIntegrations(): Promise<ModuleProbe> {
    const statuses = this.integrations.list();
    const unhealthy = statuses.filter((status) => !status.healthy).length;
    return {
      name: 'integrations',
      status: unhealthy > 0 ? 'down' : 'up',
      details: { adapters: statuses.length, unhealthy }
    };
  }

  private async probeFlags(): Promise<ModuleProbe> {
    const flags = await this.flags.list();
    return {
      name: 'feature-flags',
      status: 'up',
      details: { flags: flags.length, enabled: flags.filter((flag) => flag.enabled).length }
    };
  }
}
