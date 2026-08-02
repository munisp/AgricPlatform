import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from '../metrics/metrics.service.js';

/**
 * HTTP request metrics (observability plan §A.3). Replaces the old
 * RequestLoggingInterceptor in the same bootstrap global slot — structured
 * request logging itself is now handled by pino-http.
 *
 * The `route` label is the parameterized Express route path
 * (`/api/v1/orders/:id/status`), never `originalUrl`, so IDs and query
 * strings cannot explode label cardinality. Unmatched requests (404s before
 * routing) fall back to the single 'unmatched' label value.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    const record = (status: number): void => {
      const route =
        (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.recordHttpRequest(request.method, route, status, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (error: unknown) => {
          const status =
            error instanceof Error && 'status' in error && typeof error.status === 'number'
              ? error.status
              : 500;
          record(status);
        }
      })
    );
  }
}
