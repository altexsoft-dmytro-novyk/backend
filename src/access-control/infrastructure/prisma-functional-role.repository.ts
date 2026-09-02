import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { FunctionalRoleRepositoryPort } from '../domain/interfaces/functional-role.repository.port';

type AllowedRow = { allowed: boolean };

/**
 * One read proves the whole CAP-4 relation: active User → attachment → FR
 * policy → FR-only grant → exact canonical permission key. No result is kept
 * beyond this call, and database failures intentionally propagate.
 */
@Injectable()
export class PrismaFunctionalRoleRepository implements FunctionalRoleRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async isAllowed(userId: string, permissionKey: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<AllowedRow[]>`
      SELECT EXISTS (
        SELECT 1
          FROM "users" u
          JOIN "UserPolicies" up ON up."userId" = u."id"
          JOIN "Policies" p
            ON p."id" = up."policyId"
           AND p."type" = 'FR'
          JOIN "PolicyPermissions" pp
            ON pp."policyId" = p."id"
           AND pp."policyType" = 'FR'
          JOIN "Permissions" permission
            ON permission."id" = pp."permissionId"
         WHERE u."id" = ${userId}
           AND u."isActive" = TRUE
           AND permission."key" = ${permissionKey}
      ) AS allowed
    `;
    return row.allowed;
  }
}
