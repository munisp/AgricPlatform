import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { configuredEmbedOrigins } from '../../common/cors.js';

/**
 * Embed-feed CORS policy (GAP-L17). Replaces the per-route
 * `@Header('Access-Control-Allow-Origin', '*')` overrides, which sat on top
 * of the global CREDENTIALLED CORS policy as a divergent second regime
 * (wildcard ACAO is invalid alongside credentials, and '*' on an API that
 * also serves credentialed routes is a footgun).
 *
 * Aligned with the global policy: the request `Origin` is echoed ONLY when
 * it appears in the configured allowlist (CORS_ORIGIN plus EMBED_CORS_ORIGINS
 * for third-party widget hosts), with `Vary: Origin` so caches key per
 * origin. Requests from unlisted origins get no ACAO header (the browser
 * blocks the read) and non-browser clients send no Origin at all — both
 * fail closed. The feeds themselves stay anonymous and read-only.
 */
@Injectable()
export class EmbedCorsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const originHeader = request.headers['origin'];
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin && configuredEmbedOrigins().includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    return next.handle();
  }
}
