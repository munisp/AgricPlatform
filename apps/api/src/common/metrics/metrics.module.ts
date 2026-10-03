import { Global, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { RolesGuard } from '../auth/roles.guard.js';
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
    // GAP-L16: the canonical RBAC guard as a DI provider so
    // MetricsAccessGuard composes it instead of instantiating its own copy
    // (its dependencies — Reflector/UsersService/OidcService — are global).
    RolesGuard,
    MetricsAccessGuard
  ],
  // GAP-L16: export RolesGuard from this @Global module so it is resolvable in the
  // PrometheusModule injector that instantiates MetricsController (and MetricsAccessGuard).
  exports: [MetricsService, OperationalMetricsService, HttpMetricsInterceptor, PrometheusModule, RolesGuard]
})
export class MetricsModule {}
