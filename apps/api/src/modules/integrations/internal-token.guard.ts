import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/** Header carrying the shared event-gw ingress credential (GAP-C03/GAP-H01). */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Constant-time token comparison that never leaks length (both sides are
 * hashed first — the same pattern as metricsTokenMatches in
 * common/metrics/metrics-access.guard.ts).
 */
export function internalTokenMatches(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

/**
 * Access control for the event-gw internal event ingress
 * (POST /api/v1/internal/events, GAP-C03/GAP-H01). The event-gw sidecar
 * verifies provider-native webhook signatures at the edge and fans the
 * verified event out as an Envelope {provider, eventId, receivedAt, payload}
 * authenticated ONLY by this shared token — provider-native signature
 * headers are stripped by the sidecar and MUST NOT be trusted on this path.
 *
 * Fail-closed throughout:
 * - EVENTGW_INTERNAL_TOKEN unset/blank -> 503 (misconfiguration, never an
 *   open door);
 * - missing or mismatched X-Internal-Token -> 401, compared constant-time.
 *
 * The environment is read per request (mirrors MetricsAccessGuard) so a
 * rotated token takes effect without a restart.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const configured = process.env.EVENTGW_INTERNAL_TOKEN?.trim();
    if (!configured) {
      throw new ServiceUnavailableException(
        'Internal event ingress is not configured: EVENTGW_INTERNAL_TOKEN is unset. ' +
          'Refusing the request (fail-closed) — set the token on both the API and the ' +
          'event-gw sidecar to enable POST /api/v1/internal/events.'
      );
    }
    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const presented = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!presented || !internalTokenMatches(presented, configured)) {
      throw new UnauthorizedException(
        `Missing or invalid ${INTERNAL_TOKEN_HEADER} for the internal event ingress`
      );
    }
    return true;
  }
}
