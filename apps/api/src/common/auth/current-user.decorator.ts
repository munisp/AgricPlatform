import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@agric-platform/shared';

/**
 * Reads the authenticated user attached by RolesGuard, or null when the
 * route is unauthenticated. Phase 1 identity is header-based (`x-user-id`);
 * Phase 2 replaces this with Keycloak OIDC JWT verification.
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User | null => {
  const request = ctx.switchToHttp().getRequest<{ user?: User }>();
  return request.user ?? null;
});

/** Raw `x-user-id` header for audit attribution on unauthenticated routes. */
export const ActorId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
  return request.headers['x-user-id'] ?? 'anonymous';
});
