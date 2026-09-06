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
// `AccessControlGuard` / `IdentityCardAccessService`.
//
// It also implements `IdentityCardAccessPort` so the `canEdit` hint on
// `GET /users/:id` has a single facade-consuming home rather than a second
// adapter.

// The target-scoped read route maps to Phase-0 audience resolution: any
// non-empty audience (`self` / `reporting` / `pp` / `colleague`) over an active
// target is entitled to the `profile:identity` card (§3.2). An empty audience
// — which on this route means the target is not an active `User` — denies
// (guard → 403).
const READ_USER_FEATURE = 'user-management:read';
// The `PATCH /users/:id` gate (and the `canEdit` hint). Variant A base gate is
// `canAccessSection('profile:identity') === 'write'` (reporting-line manager
// or assigned People Partner); holding this key as a live FR grant is an OR
// override on top — see `canEditS1`.
const EDIT_USER_FEATURE = 'user-management:edit';
// The identity-card section key the kernel supports (ACM-5; renamed from the
// legacy `'S1'` string by PLAT-E4-S4.1b).
const S1_SECTION = 'profile:identity';

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

  async isAllowedForTarget(
    userId: string,
    feature: string,
    targetUserId: string,
  ): Promise<boolean> {
    if (feature === READ_USER_FEATURE) {
      const audiences = await this.facade.resolveAudiences(userId, [
        targetUserId,
      ]);
      const set = audiences.get(targetUserId);
      return set !== undefined && set.size > 0;
    }

    if (feature === EDIT_USER_FEATURE) {
      return this.canEditS1(userId, targetUserId);
    }

    // PUT /users/:id/photo is Self-only and gated by SelfOnlyGuard, not here.
    // Any other write-path target feature is fail-closed until wired.
    return false;
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

  // DEAD as of PLAT-E4-S4.1c — no caller remains: both the `PATCH /users/:id`
  // gate and the `canEdit` hint now resolve through `hasSectionAccess`. It is
  // left standing deliberately; its deletion (with `S1_SECTION`,
  // `isAllowedForTarget`, and the `READ_USER_FEATURE` / `EDIT_USER_FEATURE`
  // branches) is 4.1d's, and the `user-management:edit` OR clause below is
  // Story 4.2's, coupled to seating root in the relationship tree.
  //
  // The identity-card (`profile:identity`) edit decision as it stood before
  // 4.1c, shared by the `PATCH /users/:id` gate and the read-only `canEdit`
  // hint.
  //
  // Base gate (product decision 2026-09-02, "Variant A"): audience write-access
  // — the manager on this person's reporting line, or their assigned People
  // Partner. That is `canAccessSection('profile:identity') === 'write'`.
  //
  // OR override: a live `user-management:edit` functional permission widens the
  // base gate (e.g. the seeded root HR Admin, via `scripts/dev-grant-root.ts`).
  // It only ever WIDENS — it never opens an edit that section access itself
  // denies: a `'none'` result here (a deactivated or unknown target) stays
  // closed for every viewer, grant or not. So a holder may edit any *active*
  // card, their own included, without a reporting-line or People-Partner edge.
  //
  // NOTE: the composition here (OR) is provisional — see the access-control
  // deferred-work entry "Generalise section-access authorisation" for the
  // planned rewrite (one section-parameterised gate; §2.2 dual-gate vs Variant A
  // decided centrally).
  private async canEditS1(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    const sectionAccess = await this.facade.canAccessSection(
      viewerId,
      S1_SECTION,
      targetUserId,
    );
    if (sectionAccess === 'write') {
      return true;
    }
    if (sectionAccess === 'none') {
      // Deactivated / unknown target — never editable, override or not.
      return false;
    }
    return this.facade.isAllowed(viewerId, EDIT_USER_FEATURE);
  }
}
