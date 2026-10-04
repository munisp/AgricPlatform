import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User, UserRole } from '@agric-platform/shared';
import { UsersService } from '../../modules/users/users.service.js';
import { devHeaderAuthAllowed } from './auth.config.js';
import { OidcService, type OidcIdentity } from './oidc.service.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './roles.decorator.js';
import type { AccountStatus } from '../../database/repositories/user.repository.js';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  /** Express/Fastify request path (url used as fallback in tests). */
  path?: string;
  url?: string;
  user?: unknown;
}

/**
 * The ONLY route allowed to receive credentials as query parameters.
 * Browser EventSource clients cannot set headers, so the notification SSE
 * stream passes the bearer token as ?access_token= (RFC 6750 §2.3). Query
 * strings leak via access logs, browser history and Referer headers, so
 * every other route must use the Authorization header.
 */
const QUERY_CREDENTIALS_PATH = '/notifications/stream';

/**
 * RBAC guard. Prefers `Authorization: Bearer` (Keycloak OIDC JWT, verified
 * against the realm JWKS) and falls back to the `x-user-id` development
 * header only outside production or when `ALLOW_DEV_HEADER_AUTH=true`.
 * Bearer tokens are always verified when present — a bad token is a 401,
 * never a silent downgrade to header auth.
 *
 * DEFAULT-DENY (GAP-M05): registered globally (APP_GUARD in app.module.ts),
 * so every route passes through here. A route with no @Roles/@Authenticated
 * metadata is NOT public by default — it requires any valid platform
 * identity (401 for anonymous callers). Anonymous access must be declared
 * explicitly with @Public(), which is reserved for routes carrying their
 * own authentication control (partner HMAC/token guards, webhook signature
 * checks, MetricsAccessGuard) or intentionally public content (health
 * probes, browse catalogues, embed feeds, auth enrolment flows). @Public
 * wins over @Roles: the route's own guard then owns the auth decision.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
    private readonly oidc: OidcService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    return this.enforce(context, false);
  }

  /**
   * Role enforcement WITHOUT the @Public escape hatch (GAP-L16): used by
   * guards that compose the canonical RBAC decision on a route that is
   * itself @Public for the global guard (e.g. the metrics scrape endpoint,
   * where METRICS_TOKEN is an alternative credential evaluated first).
   */
  async enforceRoles(context: ExecutionContext): Promise<boolean> {
    return this.enforce(context, true);
  }

  private async enforce(context: ExecutionContext, ignorePublic: boolean): Promise<boolean> {
    if (!ignorePublic) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass()
      ]);
      if (isPublic) {
        return true;
      }
    }

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Default-deny: undecorated routes (no @Roles, no @Public) still
    // require a valid identity; @Roles routes additionally require a match.
    const user = await this.resolveIdentity(request);
    if (required && required.length > 0 && !user.roles.some((role) => required.includes(role))) {
      throw new ForbiddenException(`Requires one of roles: ${required.join(', ')}`);
    }
    request.user = user;
    return true;
  }

  private async resolveIdentity(request: AuthenticatedRequest): Promise<User> {
    const authorization = request.headers['authorization'];
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    // endsWith tolerates the global /api/v1 prefix (bootstrap.ts).
    const requestPath = request.path ?? request.url?.split('?')[0] ?? '';
    const queryCredentialsAllowed = requestPath.endsWith(QUERY_CREDENTIALS_PATH);
    const queryToken = queryCredentialsAllowed ? request.query?.['access_token'] : undefined;
    const queryBearer = Array.isArray(queryToken) ? queryToken[0] : queryToken;
    const bearer = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : queryBearer?.trim() || undefined;

    if (bearer) {
      let identity: OidcIdentity;
      try {
        identity = await this.oidc.verify(bearer);
      } catch (error) {
        throw new UnauthorizedException(
          `Invalid bearer token: ${error instanceof Error ? error.message : 'verification failed'}`
        );
      }
      return this.userFromToken(identity);
    }

    if (devHeaderAuthAllowed()) {
      // EventSource clients (SSE) send the same development identity as a
      // query parameter; honoured only on the SSE route and only where the
      // header itself is allowed.
      const devHeader =
        request.headers['x-user-id'] ??
        (queryCredentialsAllowed ? request.query?.['x-user-id'] : undefined);
      const userId = Array.isArray(devHeader) ? devHeader[0] : devHeader;
      // Perf P1-1: ONE folded user+status read per request (parallel-round
      // fallback on drivers without the folded read).
      const resolved = userId ? await this.users.findByIdWithStatus(userId) : undefined;
      if (resolved) {
        this.assertActive(resolved.status);
        return resolved.user;
      }
      throw new UnauthorizedException(
        userId
          ? 'Unknown x-user-id header value'
          : 'Authentication required. Provide an Authorization: Bearer token (or x-user-id in development).'
      );
    }

    throw new UnauthorizedException(
      'Authentication required. Provide a valid Authorization: Bearer token issued by the platform identity provider.'
    );
  }

  /**
   * Resolves the token subject to a repository user when one exists;
   * otherwise synthesises a least-privilege identity from the verified
   * claims so RBAC still applies (accounts may live only in Keycloak).
   */
  private async userFromToken(identity: OidcIdentity): Promise<User> {
    const resolved = await this.users.findByIdWithStatus(identity.subject);
    if (resolved) {
      this.assertActive(resolved.status);
      return resolved.user;
    }
    const now = new Date().toISOString();
    return {
      id: identity.subject,
      phone: '',
      fullName: identity.name ?? identity.subject,
      roles: identity.roles,
      preferredLanguage: 'en',
      kycTier: 'tier_0',
      isVerified: false,
      createdAt: now,
      lastActiveAt: now
    };
  }

  /**
   * Suspended accounts (admin-set account status overlay) lose API access
   * immediately, regardless of how the identity was presented: a still-valid
   * Keycloak token or development header must not bypass a suspension.
   * Deceased accounts (OB-06, V-09) are estate-frozen pending succession and
   * are blocked with a distinct message. The status arrives with the folded
   * identity read (perf P1-1), so the check stays per-request (immediate
   * suspension) without a second round trip.
   */
  private assertActive(status: AccountStatus): void {
    if (status === 'deceased') {
      throw new UnauthorizedException('Account is deceased; estate frozen pending succession.');
    }
    if (status === 'suspended') {
      throw new UnauthorizedException('Account is suspended');
    }
  }
}
