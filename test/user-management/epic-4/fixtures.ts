import type { PrismaService } from '../../../src/prisma/prisma.service';

// Shared helpers for the Epic 4 — Organisational Relationships Stage-2 E2E
// suites (`um-rel-01..03`, `07`, `08` translatable now; `09..14`
// contract-blocked but written as real `it()`).
//
// The app-booting parts (`bootstrapTestApp`, `RunFixtures`, `bearer`) are the
// Epic 0 adoption fixtures, reused verbatim — AD-3-clean boot (real
// `AppModule`, real Prisma / migrated PostgreSQL, NO provider overrides), real
// `User` + `Relationship` inserts (`fx.user()`, `fx.reportsTo()`,
// `fx.peoplePartnerOf()`, `fx.grantFunctionalRole()`), run-namespaced emails,
// and wrapped scoped teardown (relationships → policies/permissions → users,
// DEC-UM-010). This file adds only what Epic 4 needs on top: the inferred
// permission key, an unrelated-permission key for the DEC-UM-002 probe, and a
// journal-table reader that stays a CLEAN assertion failure (never a crash)
// while CC-07 is unapproved.
export {
  bootstrapTestApp,
  bearer,
  RunFixtures,
  type TestApp,
  type UserOverrides,
} from '../access-control-adoption/fixtures';

/**
 * INFERRED permission key. `access-control.md` §2.3/§3.3 names the gate only in
 * prose — "the dedicated `change organisational relationships` permission" — and
 * no catalog entry exists (`CANONICAL_PERMISSIONS` in
 * `access-control-bootstrap.ts` holds only `user-management:create` /
 * `:deactivate` / `:list`). This is a plausible `context:action` string in the
 * same namespace, isolated to one constant so a single edit realigns every
 * Epic 4 test once the real key is registered. `um-rel-07`'s gate is the
 * no-target `isAllowed(viewer, <this key>)` facade check — never an
 * `actor.position === 'HR Admin'` / role-name check (AD-4, DEC-UM-002).
 */
export const CHANGE_ORG_RELATIONSHIPS_PERMISSION =
  'user-management:change-organisational-relationships';

/**
 * An unrelated permission for the DEC-UM-002 negative probe: the denied session
 * (Ida) holds a functional role, just not *this* permission — so the denial
 * cannot be passing for "no session / no role at all".
 */
export const UNRELATED_PERMISSION = 'user-management:list';

const JOURNAL_TABLE_CANDIDATES = [
  'relationship_journal',
  'relationship_access_journal',
  'access_journal',
  'RelationshipJournal',
] as const;

/**
 * Returns the name of the §3.4 relationship/access-journal table if one exists,
 * else `null`. Uses `to_regclass`, so a missing table is a clean `null` — never
 * a thrown "relation does not exist".
 *
 * CC-07 (AD-19 Journal gate) owns the immutable journal schema, the snapshot
 * payload, reader authorization, and transaction-enrolment. No such table
 * exists on `dn-um-2` today (`schema.prisma` has no journal model; `UserEvents`
 * is explicitly not a substitute), so every `expect(... ).not.toBeNull()`
 * against this is committed-red-on-missing-model and documents the full AD-19
 * §3.4 target (exactly one immutable before/after row, same transaction as the
 * fact write).
 */
export async function relationshipJournalTable(
  prisma: PrismaService,
): Promise<string | null> {
  for (const candidate of JOURNAL_TABLE_CANDIDATES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      candidate,
    );
    if (rows[0]?.exists === true) {
      return candidate;
    }
  }
  return null;
}
