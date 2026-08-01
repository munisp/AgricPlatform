import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/** Structured request log: method, path, status, latency. */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.log(request, response.statusCode, startedAt),
        error: (error: unknown) => {
          const status =
            error instanceof Error && 'status' in error && typeof error.status === 'number'
              ? error.status
              : 500;
          this.log(request, status, startedAt);
        }
      })
    );
  }

  private log(request: Request, status: number, startedAt: bigint): void {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    this.logger.log(
      `${request.method} ${request.originalUrl} -> ${status} ${durationMs.toFixed(1)}ms`
    );
  }
}
