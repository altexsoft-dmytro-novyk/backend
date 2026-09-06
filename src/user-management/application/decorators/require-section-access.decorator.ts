import { SetMetadata } from '@nestjs/common';
import type { SectionAccessRequirement } from '../../domain/interfaces/access-control.port';

export interface RequireSectionAccessMeta {
  section: string;
  level: SectionAccessRequirement;
}

export const REQUIRE_SECTION_ACCESS_KEY = 'requireSectionAccess';

// The one section-parameterised route gate (SCP 2026-09-04 D3): "may this
// viewer read / write this section of the target named by the route's `:id`?".
// Same `SetMetadata` idiom as `require-feature.decorator.ts` — no third
// authorisation mechanism — read back by `SectionAccessGuard`.
//
// A `'write'` requirement is the D1 dual gate; a `'read'` requirement is
// audience-only. `SectionAccessGuard` never composes that rule itself: it asks
// `ACCESS_CONTROL_PORT.hasSectionAccess`, which is also what the `canEdit` hint
// calls, so the gate and the hint cannot answer differently.
export const RequireSectionAccess = (
  section: string,
  level: SectionAccessRequirement,
) =>
  SetMetadata<string, RequireSectionAccessMeta>(REQUIRE_SECTION_ACCESS_KEY, {
    section,
    level,
  });
