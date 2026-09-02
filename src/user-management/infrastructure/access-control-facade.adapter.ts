import { Injectable } from '@nestjs/common';
import { AccessControlFacade } from '../../access-control/application/access-control.facade';
import type { AccessControlPort } from '../domain/interfaces/access-control.port';
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
// target is entitled to the S1 identity card (§3.2). An empty audience — which
// on this route means the target is not an active `User` — denies (guard → 403).
const READ_USER_FEATURE = 'user-management:read';
// The `PATCH /users/:id` gate. Variant A (product decision 2026-09-02): no
// separate functional permission — the whole gate is `canAccessSection('S1')
// === 'write'` (reporting-line manager or assigned People Partner).
const EDIT_USER_FEATURE = 'user-management:edit';
// The identity-card section string the kernel supports for S1 (ACM-5).
const S1_SECTION = 'S1';

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
      // Variant A: identity-card edit is gated by S1 write-access alone — the
      // reporting-line manager or the assigned People Partner. No functional
      // permission layer on this section (§2.2's functional half is not applied
      // here; a narrower FR grant can be introduced later via the roles admin).
      const sectionAccess = await this.facade.canAccessSection(
        userId,
        S1_SECTION,
        targetUserId,
      );
      return sectionAccess === 'write';
    }

    // PUT /users/:id/photo is Self-only and gated by SelfOnlyGuard, not here.
    // Any other write-path target feature is fail-closed until wired.
    return false;
  }

  // The `canEdit` hint on `GET /users/:id`, and the gate on `PATCH /users/:id`.
  //
  // Product decision 2026-09-02 (Variant A — the identity card has no separate
  // functional permission; audience write-access is the whole gate): the
  // manager on this person's reporting line, or their assigned People Partner,
  // may edit the identity card. That is exactly `canAccessSection('S1') ===
  // 'write'`. §2.2's functional half is not applied to this section — HR Admin
  // can introduce a narrower FR grant later through the roles admin screen if
  // finer control is ever needed.
  async canEditIdentityCard(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    const sectionAccess = await this.facade.canAccessSection(
      viewerId,
      S1_SECTION,
      targetUserId,
    );
    return sectionAccess === 'write';
  }
}
