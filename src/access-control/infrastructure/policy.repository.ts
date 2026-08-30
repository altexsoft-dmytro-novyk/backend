import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PolicyReaderPort } from '../domain/interfaces/policy-reader.port';

// Access-control owns Policy/Permission/UserPolicy (AD-9) — this adapter
// touches Prisma directly for its own tables, no cross-context boundary
// involved.
@Injectable()
export class PolicyRepository implements PolicyReaderPort {
  constructor(private readonly prisma: PrismaService) {}

  async hasPermission(
    userId: string,
    permissionName: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM user_policies up
        JOIN policy_permissions pp ON pp.policy_id = up.policy_id
        JOIN permissions p ON p.id = pp.permission_id
        WHERE up.user_id = ${userId}::uuid AND p.name = ${permissionName}
      ) AS present;
    `;
    return rows[0]?.present ?? false;
  }

  async hasAnyPolicyAttached(userId: string): Promise<boolean> {
    const count = await this.prisma.userPolicy.count({
      where: { userId },
    });
    return count > 0;
  }

  async listPolicies(): Promise<{ id: string; name: string }[]> {
    return this.prisma.policy.findMany({ select: { id: true, name: true } });
  }

  async revokeUserPolicy(userId: string, policyId: string): Promise<void> {
    await this.prisma.userPolicy
      .delete({ where: { userId_policyId: { userId, policyId } } })
      .catch(() => undefined);
  }
}
