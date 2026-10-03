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

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Explicit anonymous-access marker (GAP-M05). The global RolesGuard is
 * default-deny: a route with neither @Roles/@Authenticated nor @Public
 * requires a valid platform identity. @Public opts a route out of platform
 * authentication entirely — use it ONLY where another control authenticates
 * the caller (PartnerAuthGuard, InternalTokenGuard, webhook signature/token
 * checks, MetricsAccessGuard) or the route is intentionally anonymous
 * (health probes, public browse catalogues, embed feeds, auth enrolment
 * flows). @Public wins over @Roles metadata on the same route: the route's
 * own guard remains responsible for any role enforcement.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
