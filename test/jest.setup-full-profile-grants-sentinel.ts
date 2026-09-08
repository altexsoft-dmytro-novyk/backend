import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// Cross-suite e2e test-infrastructure guard, NOT a scenario/spec assertion —
// PLAT-E4-S4.2c.
//
// KNOWN, ACCEPTED RISK (code-review finding, 2026-09-07, not fully
// eliminable without abandoning this mechanism): this plants one permanent,
// real, active `User` row in the shared e2e database for the life of the
// whole run. Every current suite's own count/list assertions are scoped by a
// run-specific `workEmail` prefix or a before/after delta (verified by
// project-wide grep before this file was accepted), so none is affected
// today — but any FUTURE suite that queries `users` without a scoping filter
// (an unscoped `prisma.user.count()`, an unfiltered directory-listing
// assertion, …) would see this row. The `'zzz-e2e-...'` email and
// `'ZZZ E2E Sentinel'` name are deliberately chosen to sort last and read as
// obviously synthetic, but that is a mitigation, not a guarantee. A future
// test author adding an unscoped user-count assertion should scope it, the
// same way every existing suite already does.
//
// `bootstrapAccessControl` (§2.4 full-profile-access overlay) seeds the FIRST
// `full_profile_grants` row the moment the table is globally empty — "zero
// rows anywhere," not "no row for root" (spec-4-2c Always/Never lists; a
// narrower condition would misfire the moment a real administrator grants a
// second holder). Several e2e suites authored BEFORE this table existed
// (`acm1r-fr-foundation.e2e-spec.ts`, `s42a-op-*`, and others) run
// `db:bootstrap:access-control` many times against throwaway, run-scoped root
// users they delete in their own teardown — they have no way to know to also
// clean up `full_profile_grants` / `access_journal` rows referencing those
// throwaway users. Left alone, whichever such suite's bootstrap call happens
// to be first (across this whole `--runInBand` process) to see
// `full_profile_grants` genuinely empty becomes the accidental "first
// holder," permanently RESTRICT-blocking that suite's own later
// `deleteMany` on its own users — a real regression this increment must not
// cause. Every sibling 4.2-increment suite, and `acm1r-fr-foundation.e2e-spec.ts`
// (amended for the six-key canonical set, DEPT-4), must stay green.
//
// Fix: keep `full_profile_grants` PERMANENTLY non-empty for the life of this
// whole e2e run, via one dedicated, permanent sentinel holder that no
// suite's own run-scoped prefix filter ever matches (so no suite's teardown
// ever tries to delete it, and no suite's own assertions — none query
// `full_profile_grants` directly except this increment's own two new files —
// ever see it). This increment's own `acm11-full-profile-overlay-*.e2e-spec.ts`
// suites explicitly reset `full_profile_grants` to a REAL zero before testing
// the bootstrap seed itself (their own Precondition), which also removes this
// sentinel row — `setupFilesAfterEnv` runs once per test FILE (registered as
// this file's own `beforeAll`, which Jest runs before that file's own
// `beforeEach`/tests), so the sentinel is idempotently re-established before
// every OTHER file's own tests start.
const SENTINEL_USER_ID = '00000000-0000-7000-8000-000000000001';
const SENTINEL_GRANT_ID = '00000000-0000-7000-8000-000000000002';
const SENTINEL_WORK_EMAIL =
  'zzz-e2e-full-profile-grants-sentinel@internal.invalid';

beforeAll(async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users"
         ("id", "firstName", "lastName", "position", "country", "workEmail",
          "companyJoinDate", "isActive", "createdBy")
       VALUES ($1, 'ZZZ E2E Sentinel', 'DoNotDelete', 'Test Fixture', 'ZZ', $2,
               DATE '2020-01-01', TRUE, $1)
       ON CONFLICT ("id") DO NOTHING`,
      SENTINEL_USER_ID,
      SENTINEL_WORK_EMAIL,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "full_profile_grants"
         ("id", "holderUserId", "grantedByUserId", "grantedAt", "revokedByUserId", "revokedAt")
       VALUES ($1, $2, NULL, CURRENT_TIMESTAMP, NULL, NULL)
       ON CONFLICT ("id") DO NOTHING`,
      SENTINEL_GRANT_ID,
      SENTINEL_USER_ID,
    );
  } catch (error) {
    // Tolerate a not-yet-migrated table (any test run against a schema
    // snapshot predating this increment's migration) the same way every
    // other reset helper in this test suite tolerates 42P01.
    const code = (error as { code?: string }).code;
    if (
      code !== '42P01' &&
      !/does not exist/i.test(String((error as Error).message))
    ) {
      throw error;
    }
  } finally {
    await prisma.$disconnect();
  }
}, 30_000);
// CORRECTED 2026-09-07 (John, PM, code-review finding): explicit per-hook
// timeout, not a global default change. This hook opens a fresh Prisma
// connection before EVERY e2e test file in the project; Jest's 5s default
// hook timeout left a real risk that a cold or loaded local Postgres could
// time out this specific hook and fail an otherwise-unrelated file. A
// `beforeAll(fn, timeout)` second argument scopes the raised timeout to only
// this hook — it does not touch the default for any other hook or test
// anywhere, so a genuinely hung test elsewhere is still caught at 5s.
