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
    const [reporting, pp] = await this.prisma.$transaction([
      // Recursive descent over `direct` edges only. The join on `users` is the
      // fail-closed filter: a deactivated person is neither a reachable target
      // nor a bridge, so a broken node terminates that branch instead of
      // handing the ancestors above it reach they never had (AD-11/AD-12).
      this.prisma.$queryRaw<IdRow[]>`
        WITH RECURSIVE reports AS (
          SELECT r."userId" AS id
            FROM "relationships" r
            JOIN "users" u ON u."id" = r."userId" AND u."isActive" = TRUE
           WHERE r."type" = 'direct'::"RelationshipType"
             AND r."reportsToUserId" = ${viewerId}
          UNION
          SELECT r."userId" AS id
            FROM "relationships" r
            JOIN reports p ON p."id" = r."reportsToUserId"
            JOIN "users" u ON u."id" = r."userId" AND u."isActive" = TRUE
           WHERE r."type" = 'direct'::"RelationshipType"
        )
        SELECT id FROM reports WHERE id IN (${ids})
      `,
      // The PP branch resolves the assigned endpoint and stops. Walking on to
      // that partner's own manager chain would be the AD-19 fail-open mistake.
      this.prisma.$queryRaw<IdRow[]>`
        SELECT r."userId" AS id
          FROM "relationships" r
          JOIN "users" u ON u."id" = r."userId" AND u."isActive" = TRUE
         WHERE r."type" = 'people_partner'::"RelationshipType"
           AND r."reportsToUserId" = ${viewerId}
           AND r."userId" IN (${ids})
      `,
    ]);

    return {
      reportingTargets: reporting.map((row) => row.id),
      ppTargets: pp.map((row) => row.id),
    };
  }
}
