import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { User } from '@agric-platform/shared';

/**
 * Ownership/admin authorisation helper. Sensitive per-user resources may be
 * accessed by the owning user or by an administrator; everyone else gets a
 * 403 (and anonymous callers a 401).
 */
export function assertSelfOrAdmin(actor: User | null, userId: string): User {
  if (!actor) {
    throw new UnauthorizedException('Authentication required for this resource');
  }
  if (actor.id === userId || actor.roles.includes('admin')) {
    return actor;
  }
  throw new ForbiddenException('You may only access your own records');
}

/** True when the actor owns the resource or is an administrator. */
export function isSelfOrAdmin(actor: User | null, userId: string): boolean {
  return Boolean(actor && (actor.id === userId || actor.roles.includes('admin')));
}
