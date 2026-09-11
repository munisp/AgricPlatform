import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional
} from '@nestjs/common';
import type { ApiErrorResponse } from '@agric-platform/shared';
import type { Request, Response } from 'express';
import type { ErrorTrackingService } from '../error-tracking/error-tracking.service.js';
import type { MetricsService } from '../metrics/metrics.service.js';

/** @deprecated Use the shared `ApiErrorResponse` contract instead. */
export type ApiErrorBody = ApiErrorResponse;

/** Reads the pino-http request id (falls back to the inbound header). */
export function resolveRequestId(request: Request): string | undefined {
  const pinoId = (request as Request & { id?: string | number }).id;
  if (pinoId !== undefined) {
    return String(pinoId);
  }
  const header = request.headers?.['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value || undefined;
}

/**
 * Consistent API error shape for all unhandled exceptions.
 *
 * Observability (plan §A.4): the envelope carries `requestId` so support can
 * correlate errors with logs/traces; 5xx is logged at error with the
 * serialized exception, counted on `agric_errors_5xx_total`, and reported to
 * Sentry (when SENTRY_DSN is set); 4xx is logged at warn and never reported.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly errorTracking?: ErrorTrackingService
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'Unexpected server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        message = (record.message as string | string[]) ?? exception.message;
        error = (record.error as string) ?? exception.name;
      }
    }

    const requestId = resolveRequestId(request);

    if (status >= 500) {
      this.metrics?.error5xx();
      this.errorTracking?.capture5xx(exception, {
        status,
        requestId,
        path: request.originalUrl
      });
      this.logger.error(
        `Unhandled error on ${request.method} ${request.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception)
      );
      // Audit A3-7: never relay a 5xx exception message to the client.
      // 5xx messages routinely embed upstream provider error bodies (e.g.
      // BadGatewayException wrapping ProviderHttpError, whose message
      // carries up to 200 chars of the provider's response — account
      // details, internal references, echoed request data). The detail
      // stays in the server logs and Sentry above; the client gets a
      // generic envelope plus the requestId for support correlation.
      message = 'Unexpected server error';
    } else {
      this.logger.warn(
        `${request.method} ${request.originalUrl} -> ${status} (${error}): ${
          Array.isArray(message) ? message.join('; ') : message
        }`
      );
    }

    const body: ApiErrorResponse = {
      statusCode: status,
      error,
      message,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
      requestId
    };
    response.status(status).json(body);
  }
}
