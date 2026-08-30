import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrgGraphRepositoryPort } from '../domain/interfaces/org-graph-repository.port';

// AD-24: reports-to walk is one indexed recursive CTE per request, not
// N+1 application-side loops. The recursive term's JOIN against `users`
// makes the walk fail closed on a broken/orphaned edge (AC-AD-08); the
// NOT EXISTS departures guard on the frontier node stops the walk from
// propagating past a due intermediate manager (AC-AD-16/17) without
// blocking that node's own (already-reached) ancestors.
const REPORTING_LINE_SQL = `
WITH RECURSIVE chain(node_id, depth) AS (
  SELECT r.holder_user_id, 1
  FROM relationships r
  JOIN users u ON u.id = r.holder_user_id
  WHERE r.subject_user_id = $1::uuid AND r.type = 'direct'

  UNION ALL

  SELECT r2.holder_user_id, c.depth + 1
  FROM chain c
  JOIN relationships r2 ON r2.subject_user_id = c.node_id AND r2.type = 'direct'
  JOIN users u2 ON u2.id = r2.holder_user_id
  WHERE c.depth < 100
    AND NOT EXISTS (
      SELECT 1 FROM departures d
      WHERE d.user_id = c.node_id AND d.effective_date <= now()
    )
)
SELECT EXISTS (SELECT 1 FROM chain WHERE node_id = $2::uuid) AS present;
`;

@Injectable()
export class OrgGraphRepository implements OrgGraphRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async isDeparted(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM departures
        WHERE user_id = ${userId}::uuid AND effective_date <= now()
      ) AS present;
    `;
    return rows[0]?.present ?? false;
  }

  async isInReportingLine(actorId: string, targetId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<{ present: boolean }[]>(
      REPORTING_LINE_SQL,
      targetId,
      actorId,
    );
    return rows[0]?.present ?? false;
  }

  async isDirectManager(actorId: string, targetId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM relationships r
        JOIN users u ON u.id = r.holder_user_id
        WHERE r.subject_user_id = ${targetId}::uuid
          AND r.holder_user_id = ${actorId}::uuid
          AND r.type = 'direct'
      ) AS present;
    `;
    return rows[0]?.present ?? false;
  }

  async isAssignedPP(actorId: string, targetId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM relationships r
        JOIN users u ON u.id = r.holder_user_id
        WHERE r.subject_user_id = ${targetId}::uuid
          AND r.holder_user_id = ${actorId}::uuid
          AND r.type = 'people_partner'
      ) AS present;
    `;
    return rows[0]?.present ?? false;
  }

  async userExists(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }
}
