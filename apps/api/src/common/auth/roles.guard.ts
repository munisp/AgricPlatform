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
import { ROLES_KEY } from './roles.decorator.js';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
}

/**
 * RBAC guard. Prefers `Authorization: Bearer` (Keycloak OIDC JWT, verified
 * against the realm JWKS) and falls back to the `x-user-id` development
 * header only outside production or when `ALLOW_DEV_HEADER_AUTH=true`.
 * Bearer tokens are always verified when present — a bad token is a 401,
 * never a silent downgrade to header auth.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
    private readonly oidc: OidcService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.resolveIdentity(request);
    if (!user.roles.some((role) => required.includes(role))) {
      throw new ForbiddenException(`Requires one of roles: ${required.join(', ')}`);
    }
    request.user = user;
    return true;
  }

  private async resolveIdentity(request: AuthenticatedRequest): Promise<User> {
    const authorization = request.headers['authorization'];
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;

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
      const devHeader = request.headers['x-user-id'];
      const userId = Array.isArray(devHeader) ? devHeader[0] : devHeader;
      const user = userId ? this.users.findById(userId) : undefined;
      if (user) {
        return user;
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
  private userFromToken(identity: OidcIdentity): User {
    const existing = this.users.findById(identity.subject);
    if (existing) {
      return existing;
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
}
