import type { PrismaService } from '../../../src/prisma/prisma.service';

// Shared helpers for the Epic 3 — Career Timeline Stage-2 E2E suites
// (auto-events / manual-events / edit-delete-events), v1.5.
//
// The app-booting parts (`bootstrapTestApp`, `RunFixtures`, `bearer`) plus the
// deploy-order script runner and the bare `rawPrisma` / CSV helpers are reused
// verbatim from the Epic 0 / Epic 1 fixtures — they already give AD-3-clean boot
// (real `AppModule`, real `UserManagementModule` + real @Global
// `AccessControlModule`, real Prisma / migrated PostgreSQL, NO `overrideProvider`
// on db / repos / router / session / facade), real `User` + `Relationship`
// inserts, the FR-grant chain (`grantFunctionalRole`), run-namespaced emails and
// wrapped scoped teardown (DEC-UM-010).
//
// This file adds only what Epic 3 needs on top: the *edit the career timeline*
// permission-key constant and two raw-SQL helpers for the `user_events`
// database-state assertions (`um-ct-01` / `um-ct-02` have no HTTP surface today —
// no `GET /users/:id/events` route — and the `UserEvents` Prisma model does not
// exist, so `prisma.userEvent` is not a compilable accessor: every event probe
// goes through `$queryRawUnsafe` against the not-yet-created `user_events`
// table).
export {
  bootstrapTestApp,
  bearer,
  RunFixtures,
  type TestApp,
  type UserOverrides,
} from '../access-control-adoption/fixtures';

export {
  IMPORT_SCRIPT,
  POPULATION_CSV_PATH,
  BACKEND_ROOT,
  type ScriptRun,
  runScript,
  rawPrisma,
  readSemicolonCsv,
  isCsvNull,
  normalizeEmail,
  relationExists,
  type CsvRow,
} from '../epic-1/fixtures';

/**
 * The runtime *edit the career timeline* functional permission (FR-12,
 * DEC-UM-001, access-control.md §2.2 dual gate).
 *
 * AMBIGUITY RESOLVED — no canonical key exists on disk. `access-control.md`
 * refers to it only in prose ("the runtime *edit the career timeline*
 * permission"); its normative §2.3 permission catalog is not in the repo, and
 * the kernel bootstrap `CANONICAL_PERMISSIONS` seeds only
 * `user-management:create` / `:deactivate` / `:list`. Per the dispatch ("if
 * unnamed, pick a lowercase `context:action` string and note it") this suite
 * picks `user-management:edit-career-timeline`, following the same
 * `context:action` shape the other user-management keys use
 * (`users.controller.ts`: `:create` / `:edit` / `:read` / `:upload-photo` /
 * `:deactivate` / `:list`). Story 3.2's scenario stage owns the final name; if
 * it differs, change this one constant.
 */
export const CAREER_TIMELINE_PERMISSION_KEY =
  'user-management:edit-career-timeline';

/** `true` iff the `user_events` relation exists — lets a test assert "model missing" crisply. */
export async function userEventsTableExists(
  prisma: PrismaService,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.user_events') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

export interface RawUserEvent {
  id: string;
  userId: string;
  type: string;
  source: string;
  eventDate: Date;
  details: unknown;
  deletedAt: Date | null;
}

/**
 * Every non-soft-deleted `user_events` row for a user, oldest first. Returns
 * `[]` when the table does not exist yet (so a caller can assert "no event was
 * written" without a crash on the missing relation).
 */
export async function queryUserEvents(
  prisma: PrismaService,
  userId: string,
): Promise<RawUserEvent[]> {
  if (!(await userEventsTableExists(prisma))) {
    return [];
  }
  return prisma.$queryRawUnsafe<RawUserEvent[]>(
    `SELECT id, "userId", type, source, "eventDate", details, "deletedAt"
       FROM "user_events"
      WHERE "userId" = $1 AND "deletedAt" IS NULL
      ORDER BY "eventDate" ASC`,
    userId,
  );
}

/**
 * Delete every `user_events` row owned by the run's users. Called first in
 * `afterEach`, ahead of `RunFixtures.cleanup()` (relationships -> policies /
 * permissions -> users), so the teardown order is events -> relationships ->
 * policies/permissions -> users (DEC-UM-010). Guarded on table existence — a
 * no-op today.
 */
export async function cleanupUserEvents(
  prisma: PrismaService,
  userIds: Iterable<string>,
): Promise<void> {
  const ids = [...userIds];
  if (ids.length === 0) return;
  try {
    if (!(await userEventsTableExists(prisma))) return;
    await prisma.$executeRawUnsafe(
      `DELETE FROM "user_events" WHERE "userId" = ANY($1::text[])`,
      ids,
    );
  } catch (error) {
    console.warn('[epic-3] cleanupUserEvents failed', error);
  }
}
