import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL, REDIS_CLIENT } from '../database/persistence.tokens.js';
import { IntegrationsService } from '../modules/integrations/integrations.service.js';

type DependencyStatus = 'up' | 'down' | 'disabled';

const PROBE_TIMEOUT_MS = 1000;

async function probe(check: () => Promise<unknown>): Promise<DependencyStatus> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)
      )
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly integrations: IntegrationsService,
    @Optional() @Inject(PG_POOL) private readonly pool: pg.Pool | null = null,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null
  ) {}

  @Get()
  @ApiOperation({ summary: 'Overall API health' })
  health() {
    return {
      status: 'ok',
      service: '@agric-platform/api',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe including integration adapter and persistence status' })
  async ready() {
    const statuses = this.integrations.list();
    const persistence: { database: DependencyStatus; redis: DependencyStatus } = {
      database: this.pool ? await probe(() => this.pool!.query('SELECT 1')) : 'disabled',
      redis: this.redis ? await probe(() => this.redis!.ping()) : 'disabled'
    };
    const degraded =
      persistence.database === 'down' ||
      persistence.redis === 'down' ||
      !statuses.every((s) => s.healthy);
    return {
      status: degraded ? 'degraded' : 'ok',
      integrations: statuses,
      persistence
    };
  }
}
