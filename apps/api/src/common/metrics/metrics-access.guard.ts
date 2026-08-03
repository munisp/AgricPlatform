import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { isProduction } from '../auth/auth.config.js';
import { OidcService } from '../auth/oidc.service.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UsersService } from '../../modules/users/users.service.js';

function extractBearer(request: Request): string | undefined {
  const header = request.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) {
    return undefined;
  }
  return value.slice('Bearer '.length).trim() || undefined;
}

/** Constant-time token comparison that never leaks length (hash both sides first). */
export function metricsTokenMatches(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

/**
 * Access control for the Prometheus scrape endpoint (observability wave).
 *
 * The /metrics payload discloses route tables, error rates and backlog
 * depths — useful recon — so access is restricted to:
 *   1. `Authorization: Bearer <METRICS_TOKEN>` (the Prometheus scrape user,
 *      compared constant-time), or
 *   2. a platform admin identity, resolved by the standard RBAC guard
 *      (OIDC bearer in production; x-user-id only where dev auth is allowed).
 *
 * Fail-closed in production: anonymous scrapes are rejected with 401 whenever
 * NODE_ENV=production. Outside production anonymous scrapes stay open so a
 * local Prometheus/docker-compose stack works without minting tokens first.
 *
 * A METRICS_TOKEN bearer that does not match is NOT a hard failure on its
 * own — the caller may be an admin presenting an OIDC token while
 * METRICS_TOKEN is also configured, so unmatched bearers fall through to the
 * standard RBAC check (which itself never downgrades a bad bearer to header
 * auth).
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  /**
   * The standard RBAC guard, composed in-place: the scrape controller lives
   * in the PrometheusModule DI context, which cannot resolve providers from
   * feature modules — but Reflector/UsersService/OidcService are global.
   */
  private readonly rolesGuard: RolesGuard;

  constructor(reflector: Reflector, users: UsersService, oidc: OidcService) {
    this.rolesGuard = new RolesGuard(reflector, users, oidc);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const metricsToken = process.env.METRICS_TOKEN;
    const bearer = extractBearer(request);

    if (metricsToken && bearer && metricsTokenMatches(bearer, metricsToken)) {
      return true;
    }

    const hasCredentials = Boolean(bearer) || Boolean(request.headers['x-user-id']);
    if (hasCredentials) {
      // The route carries @Roles('admin'); RolesGuard enforces it (401 on a
      // bad/unknown credential, 403 on a non-admin identity).
      return this.rolesGuard.canActivate(context);
    }

    if (isProduction()) {
      throw new UnauthorizedException(
        'Metrics require an admin bearer token or the METRICS_TOKEN scrape credential.'
      );
    }
    // Development/test: anonymous scrape allowed (local Prometheus parity).
    return true;
  }
}
