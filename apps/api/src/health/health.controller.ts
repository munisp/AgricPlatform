import { Controller, Get, Inject, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type pg from 'pg';
import { PG_POOL, REDIS_CLIENT } from '../database/persistence.tokens.js';
import { redisCircuitOpen } from '../redis/redis-circuit.js';
import { Public, Roles } from '../common/auth/roles.decorator.js';
import { RolesGuard } from '../common/auth/roles.guard.js';
import { OutboxSweeperService } from '../core/outbox-sweeper.service.js';

/**
 * Liveness/readiness probes (Wave P hardening). /health/live is a pure
 * process check; /health/ready verifies the real dependencies (pg pool,
 * Redis when configured) and fails closed with 503 — Kubernetes stops
 * routing to a degraded pod. The readiness payload reports the outbox
 * backlog so a stalled relay pages ops before events are lost. G14: the
 * module/driver breakdown discloses operational topology — admin-only.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool | null,
    @Inject(REDIS_CLIENT) private readonly redis: { ping(): Promise<string> } | null,
    private readonly outboxSweeper: OutboxSweeperService
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Process liveness (no dependency checks)' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  @ApiOperation({
    summary:
      'Readiness: pg + Redis probes, outbox backlog and the Redis degraded tier (503 on failure)'
  })
  async ready() {
    const checks: Record<string, string> = {};
    let healthy = true;

    if (this.pool) {
      try {
        await this.pool.query('SELECT 1');
        checks.postgres = 'up';
      } catch {
        checks.postgres = 'down';
        healthy = false;
      }
    } else {
      checks.postgres = 'in-memory (single-process mode)';
    }

    if (this.redis) {
      try {
        await this.redis.ping();
        checks.redis = 'up';
      } catch {
        checks.redis = 'down';
        healthy = false;
      }
    } else {
      checks.redis = 'in-memory (single-process mode)';
    }

    // GAP-M04/OB-09: the Redis degraded tier is part of readiness — the
    // fail-open throttle/idempotency paths rely on the pod being pulled
    // from rotation when the shared counter store is unhealthy.
    checks.redisCircuit = redisCircuitOpen() ? 'open (degraded tier)' : 'closed';

    const backlog = await this.outboxSweeper.backlog();
    const status = healthy ? 'ok' : 'degraded';
    if (!healthy) {
      throw new ServiceUnavailableException({ status, checks, outbox: backlog });
    }
    return { status, checks, outbox: backlog };
  }

  @Get('modules')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Module/driver status breakdown (admin, diagnostics; G14)' })
  modules() {
    return {
      data: {
        persistence: this.pool ? 'postgres' : 'in-memory',
        cache: this.redis ? 'redis' : 'in-memory',
        redisCircuit: redisCircuitOpen() ? 'open' : 'closed'
      }
    };
  }
}
