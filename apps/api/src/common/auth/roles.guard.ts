import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@agric-platform/shared';
import { UsersService } from '../../modules/users/users.service.js';
import { ROLES_KEY } from './roles.decorator.js';

interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: unknown;
}

/**
 * RBAC guard. Phase 1 resolves identity from the `x-user-id` header against
 * the users repository (Keycloak OIDC replaces this in production per
 * docs/architecture.md security section).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers['x-user-id'];
    const userId = Array.isArray(header) ? header[0] : header;
    const user = userId ? this.users.findById(userId) : undefined;
    if (!user) {
      throw new UnauthorizedException(
        'Authentication required. Provide a valid x-user-id header (OIDC JWT in production).'
      );
    }
    if (!user.roles.some((role) => required.includes(role))) {
      throw new ForbiddenException(`Requires one of roles: ${required.join(', ')}`);
    }
    request.user = user;
    return true;
  }
}
