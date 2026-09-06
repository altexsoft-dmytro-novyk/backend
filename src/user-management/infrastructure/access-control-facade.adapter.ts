import { Injectable } from '@nestjs/common';
import { AccessControlFacade } from '../../access-control/application/access-control.facade';
import { PROFILE_IDENTITY_SECTION } from '../domain/constants/section-keys';
import type {
  AccessControlPort,
  SectionAccessLevel,
  SectionAccessRequirement,
} from '../domain/interfaces/access-control.port';
import type { IdentityCardAccessPort } from '../domain/interfaces/identity-card-access.port';

// The real production binding for `ACCESS_CONTROL_PORT` (AD-21 cutover — this
// replaces `interim-access-control.adapter.ts`, which is deleted in the same
// change). An `infrastructure/` adapter is the ONE place User Management
// consumes `AccessControlFacade` across the AD-2 boundary (the facade is the
// public surface exported by the `@Global` AccessControlModule); it is wired by
// token in `user-management.module.ts` and injected only by
// `AccessControlGuard` / `SectionAccessGuard` / `IdentityCardAccessService`.
//
// It also implements `IdentityCardAccessPort` so the `canEdit` hint on
// `GET /users/:id` has a single facade-consuming home rather than a second
// adapter.

// Level satisfaction is by rank, not equality: a resolved level satisfies a
// requirement when it sits at or above it, so `write` satisfies a `'read'`
// requirement and `none` satisfies neither (story 4.1 "Guard semantics").
const SECTION_ACCESS_RANK: Record<SectionAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
};

@Injectable()
export class AccessControlFacadeAdapter
  implements AccessControlPort, IdentityCardAccessPort
{
  constructor(private readonly facade: AccessControlFacade) {}

  // No-target functional-permission decision — delegates straight to the
  // facade's live FR-grant-chain check. No role-name / `User.position` check
  // (the interim adapter's prohibited shortcut is gone).
  isAllowed(userId: string, feature: string): Promise<boolean> {
    return this.facade.isAllowed(userId, feature);
  }

  // The one section-parameterised authorisation question (SCP 2026-09-04 D3),
  // asked by `SectionAccessGuard` for every `@RequireSectionAccess` route and
  // by `canEditIdentityCard` for the `canEdit` hint.
  //
  // AUDIENCE-FIRST, and the ordering is the invariant rather than a style
  // choice (`docs/architecture/access-control.md:19`, NORMATIVE — "a new
  // functional role never widens data access ... feature permissions operate
  // *within* the holder's resolved audiences only"). `canAccessSection`
  // resolves first and returns `false` on its own; `isAllowed` is reached only
  // after the audience half has already allowed, so the functional half can
  // only ever subtract. An unmapped section resolves `'none'` here and denies
  // — fail-closed, no throw, no log-and-allow.
  //
  // The feature half of the D1 dual gate is `'<section>:write'`, and it is
  // consulted ONLY for a `'write'` requirement: §3.2 decides reads by audience
  // alone and `DEFAULT_PERMISSIONS` holds no `:read` key, so deriving
  // `'<section>:<level>'` uniformly would ask for a key nobody holds and deny
  // every read.
  async hasSectionAccess(
    userId: string,
    section: string,
    level: SectionAccessRequirement,
    targetUserId: string,
  ): Promise<boolean> {
    const resolved = await this.facade.canAccessSection(
      userId,
      section,
      targetUserId,
    );
    if (SECTION_ACCESS_RANK[resolved] < SECTION_ACCESS_RANK[level]) {
      return false;
    }
    if (level === 'read') {
      return true;
    }
    return this.facade.isAllowed(userId, `${section}:write`);
  }

  // The `canEdit` hint on `GET /users/:id`. Literally the same call the
  // `PATCH /users/:id` gate makes, so the hint and the gate cannot disagree.
  async canEditIdentityCard(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    return this.hasSectionAccess(
      viewerId,
      PROFILE_IDENTITY_SECTION,
      'write',
      targetUserId,
    );
  }
}
