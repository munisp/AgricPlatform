import { Global, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { HttpMetricsInterceptor } from '../interceptors/http-metrics.interceptor.js';
import { MetricsAccessGuard } from './metrics-access.guard.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { OperationalMetricsService } from './operational-metrics.service.js';

/**
 * Prometheus metrics (observability plan §A.3). The scrape endpoint lands
 * under the global prefix (/api/v1/metrics — asserted by e2e), rendered by
 * MetricsController behind MetricsAccessGuard (METRICS_TOKEN bearer or
 * admin identity; fail-closed for anonymous access in production). Global
 * so domain services can inject MetricsService without module imports.
 */
@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      controller: MetricsController,
      defaultMetrics: { enabled: true },
      defaultLabels: { service: 'agric-api' }
    })
  ],
  providers: [
    MetricsService,
    OperationalMetricsService,
    HttpMetricsInterceptor,
    MetricsAccessGuard
  ],
  exports: [MetricsService, OperationalMetricsService, HttpMetricsInterceptor, PrometheusModule]
})
export class MetricsModule {}
