import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@agric-platform/shared';

/**
 * Reads the authenticated user attached by RolesGuard (verified OIDC bearer
 * token, or the development `x-user-id` header where allowed), or null when
 * the route is unauthenticated.
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
