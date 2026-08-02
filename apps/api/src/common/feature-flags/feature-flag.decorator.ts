import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Gates a route behind a DB-backed feature flag. Applied via
 * FeatureFlagGuard (registered globally by FeatureFlagsModule); requests
 * fail closed with 404 when the flag is off for the caller.
 */
export const RequiresFeature = (flagKey: string) => SetMetadata(FEATURE_FLAG_KEY, flagKey);
