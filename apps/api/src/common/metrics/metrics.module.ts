import { Global, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { HttpMetricsInterceptor } from '../interceptors/http-metrics.interceptor.js';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus metrics (observability plan §A.3). The scrape endpoint lands
 * under the global prefix (/api/v1/metrics — asserted by e2e). Global so
 * domain services can inject MetricsService without module imports.
 */
@Global()
@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
      defaultLabels: { service: 'agric-api' }
    })
  ],
  providers: [MetricsService, HttpMetricsInterceptor],
  exports: [MetricsService, HttpMetricsInterceptor, PrometheusModule]
})
export class MetricsModule {}
