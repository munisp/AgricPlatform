import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@agric-platform/shared';
import { FEATURE_FLAG_KEY } from './feature-flag.decorator.js';
import { FeatureFlagsService } from './feature-flags.service.js';

/**
 * Enforces @RequiresFeature flags. Fail-closed: when the flag is missing,
 * disabled, or excludes the caller's roles/rollout bucket, the route
 * responds 404 (the surface does not exist for that caller) rather than
 * degrading silently.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!flagKey) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ user?: User }>();
    const user = request.user;
    const enabled = await this.flags.isEnabled(flagKey, {
      userId: user?.id,
      roles: user?.roles
    });
    if (!enabled) {
      throw new NotFoundException(`Feature '${flagKey}' is not enabled`);
    }
    return true;
  }
}
