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
// The functional permission half of the §2.2 write dual gate. Unseeded today
// (Open Decision (i) = option (a), pending) → `isAllowed` fails closed.
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

    // Write-path target features (PATCH / PUT photo) are UMAC-2; their §2.2
    // dual gate is not wired on this route yet. Fail closed.
    return false;
  }

  // §2.2 dual gate, read-only, for the `canEdit` UI hint on `GET /users/:id`.
  async canEditIdentityCard(
    viewerId: string,
    targetUserId: string,
  ): Promise<boolean> {
    const [hasEditPermission, sectionAccess] = await Promise.all([
      this.facade.isAllowed(viewerId, EDIT_USER_FEATURE),
      this.facade.canAccessSection(viewerId, S1_SECTION, targetUserId),
    ]);
    return hasEditPermission && sectionAccess === 'write';
  }
}
