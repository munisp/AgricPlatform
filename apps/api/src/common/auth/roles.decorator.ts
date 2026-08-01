import { SetMetadata } from '@nestjs/common';
import { USER_ROLES, type UserRole } from '@agric-platform/shared';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Requires any authenticated platform identity (verified OIDC bearer token,
 * or the development header where allowed). Equivalent to listing every
 * known role: any recognised account passes, anonymous callers get a 401.
 */
export const Authenticated = () => Roles(...USER_ROLES);
