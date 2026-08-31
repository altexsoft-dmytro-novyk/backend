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
        // A ceiling on the walk itself, not a performance target. §7 gives the
        // whole request 2 seconds for 500 records, so a resolution still
        // running at that point is not slow — it is wrong, and the shapes that
        // produce it are pathological data the schema still permits (a cycle in
        // the reporting chain is insertable today: the partial unique index
        // allows one `direct` row each and the CHECK only forbids self-
        // reference). Without this the request does not fail, it hangs: the
        // connection default is `statement_timeout = 0`, so a spinning
        // recursion holds its connection until the client disconnects — that
        // takes the endpoint down instead of denying one request. Measured:
        // with the guard, a cyclic graph fails the run in 3s; without it, the
        // suite ran 10 minutes and left backends spinning after Jest was killed.
        //
        // A timeout surfaces as a thrown error, never as an empty map, so a
        // degraded resolution cannot be mistaken for "no audience applies".
        // $executeRawUnsafe because SET takes no bind parameters; the value is
        // a literal constant, never interpolated input.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '2s'`);

        // Walk upward from each target through its `direct` chain. Reaching the
        // viewer is NOT the decision: it proves the viewer sits on that
        // target's chain, but the proof is provisional until the chain
        // terminates cleanly. Reporting is granted only when the whole walked
        // chain for that target ends without repeating a node — a repeat
        // anywhere, before or after the viewer is reached, denies Reporting for
        // that target alone, so a viewer inside a cycle is denied rather than
        // proven by the cycle.
        //
        // That is why the recursive term carries an explicit `path` and is
        // UNION ALL rather than UNION. Set deduplication would still halt the
        // recursion, but halting is not denying: it ends the walk while leaving
        // the viewer's row in the result, which is exactly the reachability
        // answer this rule replaces. Only a per-row path can say WHICH target's
        // walk closed on itself. `path` also makes visited state path-local by
        // construction — two targets sharing an ancestor each carry their own
        // path, so a shared ancestor is never mistaken for a repeat.
        //
        // Termination is the absence of a further USABLE manager edge. Both
        // termination cases are the same join: an absent edge produces no row,
        // and an edge whose endpoint is inactive is filtered out by the join on
        // `users e`, so it produces no row either — unusable, and therefore
        // treated as absent (AD-11/AD-12). Nothing above a dead node is
        // reachable, while a viewer already proven below it keeps Reporting,
        // because the chain has then ended without a repeat.
        //
        // Bounded by construction: `relationships_one_direct_per_user` gives
        // each person at most one `direct` row, so each target walks a single
        // path and `NOT c.repeated` stops it at the first closure. Cost stays
        // chain depth × target count.
        const reporting = await tx.$queryRaw<IdRow[]>`
          WITH RECURSIVE chain AS (
            SELECT r."userId"                                   AS target_id,
                   r."reportsToUserId"                          AS node_id,
                   ARRAY[r."userId", r."reportsToUserId"]       AS path,
                   FALSE                                        AS repeated
              FROM "relationships" r
              JOIN "users" t ON t."id" = r."userId" AND t."isActive" = TRUE
              JOIN "users" e ON e."id" = r."reportsToUserId" AND e."isActive" = TRUE
             WHERE r."type" = 'direct'::"RelationshipType"
               AND r."userId" IN (${ids})
            UNION ALL
            SELECT c.target_id,
                   r."reportsToUserId",
                   c.path || r."reportsToUserId",
                   r."reportsToUserId" = ANY(c.path)
              FROM chain c
              JOIN "relationships" r
                ON r."userId" = c.node_id
               AND r."type" = 'direct'::"RelationshipType"
              JOIN "users" e ON e."id" = r."reportsToUserId" AND e."isActive" = TRUE
             WHERE NOT c.repeated
          )
          SELECT DISTINCT c.target_id AS id
            FROM chain c
           WHERE c.node_id = ${viewerId}
             AND NOT EXISTS (
                   SELECT 1
                     FROM chain b
                    WHERE b.target_id = c.target_id
                      AND b.repeated
                 )
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
