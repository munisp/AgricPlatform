import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { Roles } from '../auth/roles.decorator.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';

/**
 * Prometheus scrape endpoint. The route path itself ('/metrics' under the
 * global /api/v1 prefix) is applied by PrometheusModule.register — this
 * subclass only layers access control onto the default renderer.
 *
 * @Roles('admin') is the fallback policy the MetricsAccessGuard enforces via
 * the standard RolesGuard when no METRICS_TOKEN bearer is presented.
 */
@Controller()
export class MetricsController extends PrometheusController {
  @Get()
  @Roles('admin')
  @UseGuards(MetricsAccessGuard)
  override index(@Res({ passthrough: true }) response: unknown): Promise<string> {
    return super.index(response);
  }
}
