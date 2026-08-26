import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AccessControlPort } from '../domain/interfaces/access-control.port';

// TEMPORARY (2026-08-26 renegotiation, see spec-1-1's Boundaries & Constraints):
// stands in for the real AccessControl facade (AD-9) until the access-control
// context ships its policy engine. The real call this replaces:
//   const isAllowed = await this.accessControl.isAllowed(userId, feature);
// Hardcoded fixture-persona allow-list, fail-closed for anyone not listed —
// delete this file wholesale once the real facade exists.
const HR_ADMIN_FEATURES = new Set([
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
]);

@Injectable()
export class InterimAccessControlAdapter implements AccessControlPort {
  constructor(private readonly prisma: PrismaService) {}

  async isAllowed(userId: string, feature: string): Promise<boolean> {
    if (!HR_ADMIN_FEATURES.has(feature)) {
      return false;
    }

    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    return actor?.position === 'HR Admin';
  }

  // TEMPORARY, same 2026-08-26 renegotiation: target-scoped tier checks
  // (Self/Manager-line/PP) need the real AD-10 recursive tier walk, which
  // doesn't exist. Per epic-1-context.md, target-scoped entitlement denial
  // is explicitly access-control's own suite's job, not user-management's —
  // confirmed by profile.e2e-spec.ts itself, which never asserts 401/403 on
  // PATCH/GET /users/:id. The real call this replaces:
  //   const tier = await this.accessControl.resolveTiers(userId, [targetUserId]);
  isAllowedForTarget(userId: string): Promise<boolean> {
    return Promise.resolve(Boolean(userId));
  }
}
