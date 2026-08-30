import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AudienceFacts,
  RelationshipGraphPort,
} from '../domain/interfaces/relationship-graph.port';

type IdRow = { id: string };

@Injectable()
export class PrismaRelationshipGraphAdapter implements RelationshipGraphPort {
  constructor(private readonly prisma: PrismaService) {}

  async loadAudienceFacts(
    viewerId: string,
    targetIds: string[],
  ): Promise<AudienceFacts> {
    if (targetIds.length === 0) {
      return { reportingTargets: [], ppTargets: [] };
    }

    const ids = Prisma.join(targetIds);

    // One transaction, two graphs. The reporting walk and the PP lookup answer
    // one decision together, so they must not observe different org states.
    //
    // Two details are load-bearing and neither is obvious:
    // - REPEATABLE READ, because the connection default is READ COMMITTED,
    //   where every statement takes a fresh snapshot — the two queries could
    //   straddle a concurrent org change and compose an audience that never
    //   existed at any single moment.
    // - the interactive form, because the array form of $transaction accepts
    //   `isolationLevel` and then silently ignores it on this driver adapter;
    //   the level only reaches PostgreSQL this way. Verified against the
    //   running database, not assumed.
    const { reporting, pp } = await this.prisma.$transaction(
      async (tx) => {
        // Walk upward from each target through its `direct` chain and test
        // whether the viewer appears among its ancestors. Cost bounds to chain
        // depth × target count, not the viewer's subtree size.
        //
        // The join on `users` is the fail-closed filter: a deactivated person
        // is neither a reachable node nor a bridge, so the walk stops there
        // instead of handing ancestors above the dead node reach they never
        // had (AD-11/AD-12).
        const reporting = await tx.$queryRaw<IdRow[]>`
          WITH RECURSIVE chain AS (
            SELECT r."userId" AS target_id, r."reportsToUserId" AS ancestor_id
              FROM "relationships" r
              JOIN "users" u ON u."id" = r."userId" AND u."isActive" = TRUE
             WHERE r."type" = 'direct'::"RelationshipType"
               AND r."userId" IN (${ids})
            UNION ALL
            SELECT c.target_id, r."reportsToUserId"
              FROM chain c
              JOIN "relationships" r
                ON r."userId" = c.ancestor_id
               AND r."type" = 'direct'::"RelationshipType"
              JOIN "users" u ON u."id" = c.ancestor_id AND u."isActive" = TRUE
             WHERE c.ancestor_id IS NOT NULL
          )
          SELECT DISTINCT target_id AS id
            FROM chain
           WHERE ancestor_id = ${viewerId}
        `;

        // The PP branch resolves the assigned endpoint and stops. Walking on to
        // that partner's own manager chain would be the AD-19 fail-open mistake.
        const pp = await tx.$queryRaw<IdRow[]>`
          SELECT r."userId" AS id
            FROM "relationships" r
            JOIN "users" u ON u."id" = r."userId" AND u."isActive" = TRUE
           WHERE r."type" = 'people_partner'::"RelationshipType"
             AND r."reportsToUserId" = ${viewerId}
             AND r."userId" IN (${ids})
        `;

        return { reporting, pp };
      },
      { isolationLevel: 'RepeatableRead' },
    );

    return {
      reportingTargets: reporting.map((row) => row.id),
      ppTargets: pp.map((row) => row.id),
    };
  }
}
