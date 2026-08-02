import { Global, Module } from '@nestjs/common';
import { FeatureFlagsController } from './feature-flags.controller.js';
import { FeatureFlagsService } from './feature-flags.service.js';

/**
 * DB-backed feature flags (Wave P). Global so any module can inject
 * FeatureFlagsService. Gated routes opt in explicitly with
 * `@UseGuards(RolesGuard, FeatureFlagGuard)` AFTER @Authenticated() so the
 * RBAC guard has populated request.user before flag evaluation.
 */
@Global()
@Module({
  controllers: [FeatureFlagsController],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService]
})
export class FeatureFlagsModule {}
