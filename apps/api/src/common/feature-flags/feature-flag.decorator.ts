import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Gates a route behind a DB-backed feature flag. This decorator ONLY sets
 * metadata: FeatureFlagGuard is NOT registered globally — every gated
 * controller/route must declare it explicitly, e.g.
 * `@UseGuards(RolesGuard, FeatureFlagGuard)` (after the guard that
 * populates request.user). Requests fail closed with 404 when the flag is
 * off for the caller.
 */
export const RequiresFeature = (flagKey: string) => SetMetadata(FEATURE_FLAG_KEY, flagKey);
