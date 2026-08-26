import { SetMetadata } from '@nestjs/common';

export interface RequireFeatureMeta {
  feature: string;
  targetScoped: boolean;
}

export const REQUIRE_FEATURE_KEY = 'requireFeature';

// No-target FR capability check (e.g. POST /users, DELETE /users/:id — AD-9).
export const RequireFeature = (feature: string) =>
  SetMetadata<string, RequireFeatureMeta>(REQUIRE_FEATURE_KEY, {
    feature,
    targetScoped: false,
  });

// Target-scoped tier check against the route's `:id` param (e.g.
// PATCH/GET /users/:id).
export const RequireFeatureForTarget = (feature: string) =>
  SetMetadata<string, RequireFeatureMeta>(REQUIRE_FEATURE_KEY, {
    feature,
    targetScoped: true,
  });
