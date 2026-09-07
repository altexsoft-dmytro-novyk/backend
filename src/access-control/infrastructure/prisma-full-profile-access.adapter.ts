import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { FullProfileAccessPort } from '../domain/interfaces/full-profile-access.port';

type ExistsRow = { exists: boolean };

const LAST_HOLDER_LOCK_NAME = 'access-control:full-profile-grants:last-holder';

/** The interactive-transaction client type (same derivation as
 *  `access-control-bootstrap.ts`'s `Tx` / `org-relationship.repository.ts`'s
 *  `PrismaTx`). */
type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * One raw-SQL `EXISTS` query, no second round trip — mirrors
 * `PrismaFunctionalRoleRepository`'s `isAllowed`.
 */
@Injectable()
export class PrismaFullProfileAccessAdapter implements FullProfileAccessPort {
  constructor(private readonly prisma: PrismaService) {}

  async isActiveHolder(userId: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<ExistsRow[]>`
      SELECT EXISTS (
        SELECT 1
          FROM "full_profile_grants" g
          JOIN "users" u ON u."id" = g."holderUserId"
         WHERE g."holderUserId" = ${userId}
           AND g."revokedAt" IS NULL
           AND u."isActive" = TRUE
      ) AS exists
    `;
    return row.exists;
  }

  /**
   * AF-3 last-holder protection — the application-layer, lock-only mechanism
   * (`solution-design-full-profile-access-overlay.md` §2.2,
   * `spec-4-2c-full-profile-access-overlay.md` Always list). DEFINED here,
   * NOT EXERCISED by this increment: PLAT-E4-S4.2c only ever inserts the
   * FIRST `FullProfileGrant` row (the bootstrap seed); no task in this
   * increment deletes or revokes one, and this method is never called by any
   * production code path this increment ships.
   *
   * The future lifecycle increment's revoke command calls this inside the
   * SAME transaction as its own revoke write, before performing it — mirrors
   * `acquireBootstrapLock` / `pg_try_advisory_xact_lock`
   * (`access-control-bootstrap.ts:111-128`). Postgres refuses `FOR UPDATE`
   * combined with an aggregate function, so the count is taken in
   * application code over the locked row set, not via `SELECT count(*) ...
   * FOR UPDATE` (independently verified against a live Postgres 18: "ERROR:
   * FOR UPDATE is not allowed with aggregate functions").
   */
  async assertHolderCountAboveOneUnderLock(tx: Tx): Promise<void> {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      LAST_HOLDER_LOCK_NAME,
    );
    const currentHolders = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "full_profile_grants" WHERE "revokedAt" IS NULL FOR UPDATE`,
    );
    if (currentHolders.length <= 1) {
      throw new Error(
        'Cannot revoke the last full-profile-access holder — at least one holder must remain.',
      );
    }
  }
}
