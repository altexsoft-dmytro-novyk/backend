import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../src/generated/prisma/client';

// PLAT-E4-S4.2c — full-profile-access overlay · AD-1 Stage 2, DB-level suite.
//
// Scenarios: docs/test-cases/access-control-kernel/full-profile-overlay/
//   acm11-fpo-01-bootstrap-seeds-root-as-first-holder.md
//   acm11-fpo-02-rerun-is-idempotent-no-duplicate-row.md
//
// HARNESS SHAPE (both scenario docs' own Trace sections; spec
// spec-4-2c-full-profile-access-overlay.md Tasks & Acceptance, Stage 2
// bullet): subprocess-only, no Nest — the `acm1r-fr-foundation.e2e-spec.ts` /
// `s42a-op-bootstrap-canonical-set.e2e-spec.ts` /
// `s42b-tr-bootstrap-no-relationship-row.e2e-spec.ts` pattern, reused
// verbatim. Run the real deploy-time entrypoints (`db:seed`,
// `db:bootstrap:access-control`) as subprocesses and assert against a raw
// `PrismaClient`. There is no facade call to make — the subject is the
// deploy-time bootstrap step itself.
//
// ISOLATION (same section, reused unchanged and NOT reinvented):
// `resetBootstrapState()` deletes the five existing bootstrap-owned tables in
// RESTRICT-safe order before every test and after the suite, EXTENDED here to
// also reset `full_profile_grants` — the doc's own Precondition 1
// ("a Stage-2 harness extension named explicitly in the spec's Tasks &
// Acceptance") — tolerated as "relation does not exist" (Postgres 42P01)
// exactly like the other five, because the table does not exist until
// Stage 3's migration lands. A run-scoped `users.workEmail` prefix sweep
// (`deleteRunUsers`) removes stray rows from a previous failed run without
// touching any other suite's fixtures sharing the one `--runInBand`
// database; it also clears any `access_journal` row referencing this run's
// users BEFORE deleting them, reusing `s42d-ds-dev-seed-spine.e2e-spec.ts`'s
// `cleanupAccessJournalRows` helper verbatim (RESTRICT FK on both
// `actorUserId`/`subjectUserId`, `schema.prisma:101`/`:107`) — needed here
// because Stage 3's bootstrap seed writes exactly one such row, self-
// referencing root as both actor and subject.
//
// EXPECTED RED at HEAD de508c9: `full_profile_grants` has no backing table
// (no `FullProfileGrant` Prisma model exists yet) — every assertion below
// that queries it fails with "relation \"full_profile_grants\" does not
// exist" (Postgres 42P01), and the `access_journal` assertions fail because
// no writer inserts a `kind: 'full_profile_grant'` row yet. This is the
// correct red state for this stage, not a defect in this suite.

// Every test shells out to the real deploy-time entrypoints; Jest's 5s
// default would abort them before their own logic ran (acm1r-fr-foundation
// and s42b-tr-* carry the same guard).
jest.setTimeout(120_000);

const execFileAsync = promisify(execFile);
const backendRoot = `${__dirname}/../..`;
const runId = `acm11-fpo-${Date.now()}-${uuidv7()}`;

type CommandRun = { exitCode: number; output: string };

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<CommandRun> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
      cwd: backendRoot,
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error: unknown) {
    const failure = error as {
      code?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

const runSeed = (rootWorkEmail: string) =>
  runScript('db:seed', { ROOT_WORK_EMAIL: rootWorkEmail });

const runBootstrap = (rootWorkEmail: string) =>
  runScript('db:bootstrap:access-control', { ROOT_WORK_EMAIL: rootWorkEmail });

const sql = <T = unknown>(query: string, ...params: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(query, ...params);

const execSql = (query: string, ...params: unknown[]) =>
  prisma.$executeRawUnsafe(query, ...params);

async function countOf(table: string): Promise<number> {
  const [row] = await sql<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "${table}"`,
  );
  return Number(row.n);
}

/** Teardown tolerates a missing relation (42P01) ONLY; nothing else. */
async function tolerantDelete(table: string): Promise<void> {
  try {
    await execSql(`DELETE FROM "${table}"`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code !== '42P01' &&
      !/does not exist/i.test(String((error as Error).message))
    ) {
      throw error;
    }
  }
}

/**
 * `acm1r-fr-foundation.e2e-spec.ts` / `s42b-tr-*`, EXTENDED with
 * `full_profile_grants` per this suite's own scope (spec Tasks & Acceptance,
 * Stage-2 bullet: "resetBootstrapState-style teardown extended to also clear
 * full_profile_grants"). `full_profile_grants` has no FK to any of the other
 * five tables (only to `users`), so its position in the list is not itself
 * load-bearing, but it must run before `deleteRunUsers()` below — a live
 * grant row would RESTRICT-block deleting the user it names as holder.
 */
async function resetBootstrapState(): Promise<void> {
  for (const table of [
    'AccessControlBootstrap',
    'UserPolicies',
    'PolicyPermissions',
    'Permissions',
    'Policies',
    'full_profile_grants',
  ]) {
    await tolerantDelete(table);
  }
}

/**
 * `access_journal` rows carry RESTRICT FKs on both `subjectUserId` and
 * `actorUserId` (`schema.prisma:101`/`:107`) — every row touching this run's
 * users must go before any user row, or teardown itself throws. Reused
 * verbatim from `s42d-ds-dev-seed-spine.e2e-spec.ts`'s
 * `cleanupAccessJournalRows`, needed here because Stage 3's bootstrap seed
 * writes exactly one such row, self-referencing root as both actor and
 * subject.
 */
async function cleanupAccessJournalRows(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await execSql(
      `DELETE FROM "access_journal"
        WHERE "subjectUserId" = ANY($1::text[]) OR "actorUserId" = ANY($1::text[])`,
      userIds,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code !== '42P01' &&
      !/does not exist/i.test(String((error as Error).message))
    ) {
      throw error;
    }
  }
}

/** `acm1r-fr-foundation.e2e-spec.ts` / `s42b-tr-*`, with this suite's own prefix. */
async function deleteRunUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, workEmail: true },
  });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith('acm11-fpo-'))
    .map(({ id }) => id);
  if (ids.length > 0) {
    await cleanupAccessJournalRows(ids);
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeEach(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
});

afterAll(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
  await prisma.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────
// ACM11-FPO-01 — a fresh bootstrap seeds root as the first full-profile-
// access holder.
// ───────────────────────────────────────────────────────────────────────────
describe('ACM11-FPO-01 · a fresh bootstrap seeds root as the first full-profile-access holder', () => {
  it('ACM11-FPO-01 Test · db:seed && db:bootstrap:access-control leaves exactly one full_profile_grants row and one paired access_journal row', async () => {
    const email = emailFor('root');

    // ── Preconditions, asserted not assumed (doc "Preconditions" 1-3, doc's
    // own preconditionState SQL block). EXPECTED RED: `full_profile_grants`
    // does not exist yet at HEAD de508c9, so this first assertion itself
    // fails with "relation does not exist" — the correct red state.
    expect(await countOf('full_profile_grants')).toBe(0);
    expect(await prisma.user.count({ where: { workEmail: email } })).toBe(0);

    // ── When: the real, binding deploy-order pair.
    const seed = await runSeed(email);
    expect(seed.exitCode).toBe(0);

    const root = await prisma.user.findUnique({ where: { workEmail: email } });
    expect(root).not.toBeNull();
    expect(root!.isActive).toBe(true);

    const bootstrap = await runBootstrap(email);
    expect(bootstrap.exitCode).toBe(0);

    // ── Then: exactly one full_profile_grants row, root as holder, no
    // granting actor (the sanctioned bootstrap exception, Always list).
    const grants = await sql<{
      holderUserId: string;
      grantedByUserId: string | null;
      revokedByUserId: string | null;
      revokedAt: string | null;
    }>(
      `SELECT "holderUserId", "grantedByUserId", "revokedByUserId", "revokedAt"
         FROM "full_profile_grants"`,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toEqual({
      holderUserId: root!.id,
      grantedByUserId: null,
      revokedByUserId: null,
      revokedAt: null,
    });

    // ── Then: exactly one paired access_journal row, self-referencing root
    // as both actor and subject (AccessJournal.actorUserId is NOT NULL,
    // schema.prisma:101).
    const journalRows = await sql<{
      actorUserId: string;
      subjectUserId: string | null;
      kind: string;
      after: { holderUserId?: string } | null;
    }>(
      `SELECT "actorUserId", "subjectUserId", "kind", "after"
         FROM "access_journal"
        WHERE "kind" = 'full_profile_grant'`,
    );
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0].actorUserId).toBe(root!.id);
    expect(journalRows[0].subjectUserId).toBe(root!.id);
    expect(journalRows[0].after?.holderUserId).toBe(root!.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ACM11-FPO-02 — re-running the bootstrap over an already-seeded database
// inserts no second row.
// ───────────────────────────────────────────────────────────────────────────
describe('ACM11-FPO-02 · rerunning the bootstrap over a seeded full_profile_grants table is a no-op', () => {
  it('ACM11-FPO-02 Test · a second db:bootstrap:access-control run changes nothing', async () => {
    const email = emailFor('rerun');

    // ── Establish the ACM11-FPO-01 outcome for real, in this same test: this
    // file's `beforeEach` resets state before every `it`, so "already
    // completed once" (doc Preconditions) is produced here, not assumed or
    // hardcoded (nest-e2e.md "Preconditions must be real, not assumed").
    const seed = await runSeed(email);
    expect(seed.exitCode).toBe(0);
    const root = await prisma.user.findUnique({ where: { workEmail: email } });
    expect(root).not.toBeNull();

    const firstBootstrap = await runBootstrap(email);
    expect(firstBootstrap.exitCode).toBe(0);

    // Capture the baseline row's id and every column (doc's own
    // preconditionState: "the single row's id and column values captured
    // after the first run"). EXPECTED RED: `full_profile_grants` does not
    // exist yet, so this capture itself fails.
    const baselineGrant = (
      await sql<{
        id: string;
        holderUserId: string;
        grantedByUserId: string | null;
        revokedAt: string | null;
      }>(
        `SELECT "id", "holderUserId", "grantedByUserId", "revokedAt"
           FROM "full_profile_grants"`,
      )
    )[0];
    expect(baselineGrant).toBeDefined();

    const baselineJournal = (
      await sql<{ id: string }>(
        `SELECT "id" FROM "access_journal" WHERE "kind" = 'full_profile_grant'`,
      )
    )[0];
    expect(baselineJournal).toBeDefined();

    // ── When: the second, unchanged-environment run.
    const secondBootstrap = await runBootstrap(email);
    expect(secondBootstrap.exitCode).toBe(0);

    // ── Then: no drift, no duplicate — byte-identical to the baseline.
    expect(await countOf('full_profile_grants')).toBe(1);

    const [journalCountRow] = await sql<{ n: bigint }>(
      `SELECT count(*)::bigint AS n FROM "access_journal" WHERE "kind" = 'full_profile_grant'`,
    );
    expect(Number(journalCountRow.n)).toBe(1);

    const grantAfter = (
      await sql<{
        id: string;
        holderUserId: string;
        grantedByUserId: string | null;
        revokedAt: string | null;
      }>(
        `SELECT "id", "holderUserId", "grantedByUserId", "revokedAt"
           FROM "full_profile_grants"`,
      )
    )[0];
    expect(grantAfter).toEqual(baselineGrant);

    const journalAfter = (
      await sql<{ id: string }>(
        `SELECT "id" FROM "access_journal" WHERE "kind" = 'full_profile_grant'`,
      )
    )[0];
    expect(journalAfter).toEqual(baselineJournal);
  });
});
