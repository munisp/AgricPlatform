import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { Public, Roles } from '../auth/roles.decorator.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';

/**
 * Prometheus scrape endpoint. The route path itself ('/metrics' under the
 * global /api/v1 prefix) is applied by PrometheusModule.register — this
 * subclass only layers access control onto the default renderer.
 *
 * @Public opts the route out of the global default-deny RolesGuard so the
 * METRICS_TOKEN scrape credential can be evaluated first; MetricsAccessGuard
 * then owns the full auth decision, enforcing @Roles('admin') via the
 * canonical RolesGuard (public escape hatch disabled) when no METRICS_TOKEN
 * bearer is presented. GAP-M06: Prometheus scrapes are probe traffic and
 * must not consume the shared per-IP throttle budget behind ingress.
 */
@Controller()
export class MetricsController extends PrometheusController {
  @Get()
  @Public()
  @SkipThrottle()
  @Roles('admin')
  @UseGuards(MetricsAccessGuard)
  override index(@Res({ passthrough: true }) response: unknown): Promise<string> {
    return super.index(response);
  }
}
