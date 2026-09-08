import { SetMetadata } from '@nestjs/common';

export interface RequireFeatureMeta {
  feature: string;
}

export const REQUIRE_FEATURE_KEY = 'requireFeature';

// Functional-permission capability check against the caller alone, with no
// target (e.g. POST /users, DELETE /users/:id — AD-9). Per-person, per-section
// authorisation is `@RequireSectionAccess` (SCP 2026-09-04 D3), never this.
export const RequireFeature = (feature: string) =>
  SetMetadata<string, RequireFeatureMeta>(REQUIRE_FEATURE_KEY, {
    feature,
  });
