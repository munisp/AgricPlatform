import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User, UserRole } from '@agric-platform/shared';
import { devHeaderAuthAllowed } from './auth.config.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './roles.decorator.js';
import { OidcService } from './oidc.service.js';
import { UsersService } from '../../modules/users/users.service.js';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: User;
}

/**
 * Global RBAC guard (registered via APP_GUARD in app.module.ts).
 *
 * Default-deny (GAP-M05): a route with NO role metadata and no @Public
 * marker requires any authenticated platform identity. @Roles(...) narrows
 * to the listed roles. @Public opts out of platform authentication
 * entirely — the route's own guard (PartnerAuthGuard, InternalTokenGuard,
 * webhook signature checks, MetricsAccessGuard) then owns the decision.
 *
 * Identity resolution order: verified OIDC bearer token (always honoured);
 * the x-user-id development header only where devHeaderAuthAllowed()
 * (never in production unless ALLOW_DEV_HEADER_AUTH=true). A bearer that
 * fails verification is NEVER downgraded to header auth — that would let
 * an attacker pair a garbage token with a chosen identity.
 *
 * Deceased accounts are blocked at the guard (estate-frozen identity can
 * never act); suspended accounts pass authentication and are blocked at
 * the specific write paths that check session.status.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(OidcService) private readonly oidc: OidcService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() !== 'http') {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) {
      return true;
    }
    return this.enforceRoles(context);
  }

  /**
   * The role-enforcement decision, exposed so composed guards
   * (MetricsAccessGuard, GAP-L16) can run the SAME check with the @Public
   * escape hatch disabled — a route that is public to the GLOBAL guard but
   * still carries @Roles metadata.
   */
  async enforceRoles(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.resolveUser(request);
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }
    if (user.status === 'deceased') {
      throw new ForbiddenException(
        'This account is frozen pending estate resolution and cannot perform actions'
      );
    }
    request.user = user;
    // Default-deny: no @Roles metadata = any authenticated identity.
    if (!required || required.length === 0) {
      return true;
    }
    if (!required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException(
        `Requires role: ${required.join(' or ')} (you have: ${user.roles.join(', ') || 'none'})`
      );
    }
    return true;
  }

  private async resolveUser(request: AuthenticatedRequest): Promise<User | undefined> {
    const authorization = request.headers['authorization'];
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    if (bearer) {
      // A presented bearer is ALWAYS verified; failure never downgrades to
      // the development header (token-smuggling guard).
      const identity = await this.oidc.verify(bearer);
      const resolved = await this.users.findByIdWithStatus(identity.subject);
      if (resolved) {
        return resolved.user;
      }
      throw new UnauthorizedException('Bearer token subject is not a registered user');
    }
    if (!devHeaderAuthAllowed()) {
      return undefined;
    }
    const headerIdentity = request.headers['x-user-id'];
    const userId = Array.isArray(headerIdentity) ? headerIdentity[0] : headerIdentity;
    if (!userId) {
      return undefined;
    }
    const resolved = await this.users.findByIdWithStatus(userId);
    return resolved?.user;
  }
}
