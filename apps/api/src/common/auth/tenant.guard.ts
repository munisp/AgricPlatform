import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable
} from '@nestjs/common';
import type { User } from '@agric-platform/shared';
import { PARTNER_MEMBER_REPOSITORY } from '../../database/persistence.tokens.js';
import type { PartnerMemberRepository } from '../../database/repositories/partner-member.repository.js';

interface TenantScopedRequest {
  params?: Record<string, unknown>;
  user?: unknown;
}

/**
 * Pipeline tenant enforcement (GAP-M08). Tenant identity previously flowed
 * only into telemetry (`tenant.id` span attribute, tenant-context.ts) while
 * cross-tenant isolation rested on every service remembering its own
 * ownership check. This guard moves the EXISTING user-channel binding into
 * the request pipeline — it deliberately does not introduce a new tenancy
 * model:
 *
 *  - Routes parameterised by `:partnerId` apply the Stage-24 rule from
 *    PartnerService.assertPartnerAccess (audit A2-1): admins are
 *    unrestricted; every other authenticated caller must hold a
 *    partners.partner_members row binding their user id to the requested
 *    partner organisation (fail closed: no row ⇒ 403).
 *  - Requests with no authenticated platform user are skipped: @Public
 *    partner-M2M routes authenticate AFTER the global guards
 *    (PartnerAuthGuard) and bind the tenant from the token claim via
 *    assertPartnerTenant; other public routes carry no tenant at all.
 *
 * The guard is registered globally (APP_GUARD in app.module.ts, after
 * RolesGuard so request.user is already resolved). The service-level
 * assertions stay in place as defence in depth.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(PARTNER_MEMBER_REPOSITORY)
    private readonly members: PartnerMemberRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() !== 'http') {
      return true;
    }
    const request = context.switchToHttp().getRequest<TenantScopedRequest>();
    const partnerId = request.params?.['partnerId'];
    if (typeof partnerId !== 'string' || partnerId.length === 0) {
      return true;
    }
    const user = request.user as User | undefined;
    if (!user || user.roles.includes('admin')) {
      return true;
    }
    const membership = await this.members.findOne({ userId: user.id, partnerId });
    if (!membership) {
      throw new ForbiddenException(
        `Caller is not a registered member of partner organisation '${partnerId}'`
      );
    }
    return true;
  }
}
