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
  expectLeakFreeBody,
  RunFixtures,
  type TestApp,
  type UserOverrides,
} from '../access-control-adoption/fixtures';

/**
 * The write gate for every Epic 4 organisational-relationship mutation. The
 * FR-permission-matrix draft (2026-09-02,
 * `_bmad-output/implementation-artifacts/access-control/fr-permission-matrix-draft-2026-09-02.md`
 * §3 "Mentorship & org") settles the key for the §2.3 "change organisational
 * relationships" permission to the `<domain>:<object>:<operation>` shape:
 * **`org:relationships:write`**. It is NOT seeded (`CANONICAL_PERMISSIONS` in
 * `access-control-bootstrap.ts` holds only `user-management:create` /
 * `:deactivate` / `:list`), so `isAllowed` is `false` for every viewer until a
 * suite grants it explicitly via
 * `fx.grantFunctionalRole(userId, [ORG_RELATIONSHIPS_WRITE_PERMISSION])`.
 * `um-rel-07`'s gate is the no-target `isAllowed(viewer, <this key>)` facade
 * check — never an `actor.position === 'HR Admin'` / role-name check (AD-4,
 * DEC-UM-002).
 */
export const ORG_RELATIONSHIPS_WRITE_PERMISSION = 'org:relationships:write';

/**
 * Legacy export name kept so the still-gated Story 4.2 / 4.3 sibling suites
 * (`people-partner-change`, `department-change`) keep compiling unchanged; the
 * value is the settled FR-matrix key above.
 */
export const CHANGE_ORG_RELATIONSHIPS_PERMISSION =
  ORG_RELATIONSHIPS_WRITE_PERMISSION;

/**
 * An unrelated permission for the DEC-UM-002 capability-negative probe: Ida
 * holds a functional role whose only permission is `campaigns:create` (the
 * `um-rel-07` "create form campaigns" persona), just not *this* permission — so
 * the denial cannot be passing for "no session / no role at all".
 */
export const UNRELATED_PERMISSION = 'campaigns:create';

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

// ---------------------------------------------------------------------------
// AccessJournal (PM/AD-29) — Story 4.1 stands this table up alongside the
// (already-present, Epic 0) `Relationship` model. The table, its writer, and the
// `GET /users/:id/access-journal` read endpoint are all implementation-absent on
// this branch. The helpers below mirror epic-3's `userEventsTableExists` /
// `queryUserEvents` pattern: every probe is `to_regclass`-guarded, so a suite
// asserting "exactly one journal row" reads as a clean red (expected 1, got 0)
// rather than throwing "relation \"access_journal\" does not exist".
// ---------------------------------------------------------------------------

/** Ratified `kind` enum (`database-schema.md` §AccessJournal). Story 4.1 writes only `manager`. */
export const ACCESS_JOURNAL_KINDS = [
  'manager',
  'people_partner',
  'department_membership',
  'department_manager',
  'full_profile_grant',
  'full_profile_revoke',
  'shared_link_access',
] as const;

export type AccessJournalKind = (typeof ACCESS_JOURNAL_KINDS)[number];

export interface RawAccessJournalRow {
  id: string;
  occurredAt: Date;
  actorUserId: string;
  subjectUserId: string;
  kind: string;
  before: unknown;
  after: unknown;
  idempotencyKey: string | null;
}

/** `true` iff the `access_journal` relation exists — lets a test assert "model missing" crisply. */
export async function accessJournalTableExists(
  prisma: PrismaService,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.access_journal') IS NOT NULL AS "exists"`,
  );
  return rows[0]?.exists === true;
}

/**
 * Every `AccessJournal` row for `subjectUserId` (optionally filtered by `kind`),
 * newest-first — the §3.4 read order. Returns `[]` when the table does not exist
 * yet, so "exactly one row was written in the same transaction" is a committed
 * red assertion, not a crash.
 */
export async function queryAccessJournalRows(
  prisma: PrismaService,
  subjectUserId: string,
  kind?: AccessJournalKind,
): Promise<RawAccessJournalRow[]> {
  if (!(await accessJournalTableExists(prisma))) {
    return [];
  }
  const where = kind
    ? `"subjectUserId" = $1 AND kind = $2`
    : `"subjectUserId" = $1`;
  const params = kind ? [subjectUserId, kind] : [subjectUserId];
  return prisma.$queryRawUnsafe<RawAccessJournalRow[]>(
    `SELECT id, "occurredAt", "actorUserId", "subjectUserId", kind, before, after, "idempotencyKey"
       FROM "access_journal"
      WHERE ${where}
      ORDER BY "occurredAt" DESC`,
    ...params,
  );
}

/**
 * Every `AccessJournal` row of a given `kind`, newest-first — regardless of
 * `subjectUserId`. Story 4.3's `department_manager` row has a **department**
 * subject, not a user (the `subjectUserId` FK is to `User`); Stage 3 lands the
 * exact subject column (`spec-4-3` flag — a nullable `subjectDepartmentId`). A
 * Stage-2 test therefore locates the row by `kind` + `before`/`after` only,
 * never by subject. Returns `[]` when the table does not exist yet.
 */
export async function queryAccessJournalRowsByKind(
  prisma: PrismaService,
  kind: AccessJournalKind,
): Promise<RawAccessJournalRow[]> {
  if (!(await accessJournalTableExists(prisma))) {
    return [];
  }
  return prisma.$queryRawUnsafe<RawAccessJournalRow[]>(
    `SELECT id, "occurredAt", "actorUserId", "subjectUserId", kind, before, after, "idempotencyKey"
       FROM "access_journal"
      WHERE kind = $1
      ORDER BY "occurredAt" DESC`,
    kind,
  );
}

/**
 * Delete every `access_journal` row touching the run's users. Call first in
 * `afterEach`, ahead of `RunFixtures.cleanup()` (relationships → policies /
 * permissions → users), so teardown order is journal → relationships →
 * policies/permissions → users (DEC-UM-010). Guarded on table existence — a
 * no-op today.
 */
export async function cleanupAccessJournal(
  prisma: PrismaService,
  userIds: Iterable<string>,
): Promise<void> {
  const ids = [...userIds];
  if (ids.length === 0) return;
  try {
    if (!(await accessJournalTableExists(prisma))) return;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "access_journal"
        WHERE "subjectUserId" = ANY($1::text[]) OR "actorUserId" = ANY($1::text[])`,
      ids,
    );
  } catch (error) {
    console.warn('[epic-4] cleanupAccessJournal failed', error);
  }
}
