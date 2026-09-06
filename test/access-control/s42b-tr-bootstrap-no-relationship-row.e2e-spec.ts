import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../src/generated/prisma/client';

// PLAT-E4-S4.2b — tree-root seed · AD-1 Stage 2, DB-level suite (AF-3 split).
//
// Scenario: docs/test-cases/access-control-kernel/tree-root-seed/
//   s42b-tr-01-bootstrap-writes-no-relationship-row.md
//
// HARNESS SHAPE (spec-4-2b-tree-root-seed.md, Ask First AF-3, Code Map §
// "Precedent harnesses"): subprocess-only, no Nest — the plain
// `acm1r-fr-foundation.e2e-spec.ts` / `s42a-op-bootstrap-canonical-set.e2e-spec.ts`
// pattern, reused verbatim. Run the real deploy-time entrypoints (`db:seed`,
// `db:bootstrap:access-control`) as subprocesses and assert against a raw
// `PrismaClient`. There is no facade call to make — the subject is the
// deploy-time bootstrap step itself.
//
// ISOLATION (same section, reused unchanged and NOT reinvented):
// `resetBootstrapState()` deletes the five bootstrap-owned tables in
// RESTRICT-safe order before every test and after the suite; a run-scoped
// `users.workEmail` prefix sweep (`deleteRunUsers`) removes stray rows from a
// previous failed run without touching any other suite's fixtures sharing the
// one `--runInBand` database.
//
// EXPECTED GREEN ON FIRST RUN against unmodified source (spec-4-2b Boundaries
// & Constraints, "State plainly ... that no red state is expected"; Tasks &
// Acceptance, Stage 2). This is a regression lock over an already-correct
// property — root's "top of the tree" position is the ABSENCE of a
// `Relationship` row, not a row anyone writes — not a red-to-green story. A
// nonzero count on any assertion below is a genuine defect finding to report
// in a different story, never something this suite may "fix" by adding a
// guard (spec Boundaries & Constraints, Never list).

// Every test shells out to the real deploy-time entrypoints; Jest's 5s default
// would abort them before their own logic ran (acm1r-fr-foundation.e2e-spec.ts
// carries the same guard).
jest.setTimeout(120_000);

const execFileAsync = promisify(execFile);
const backendRoot = `${__dirname}/../..`;
const runId = `s42b-tr-${Date.now()}-${uuidv7()}`;

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

async function countRelationshipsWhere(
  column: 'userId' | 'reportsToUserId',
  userId: string,
): Promise<number> {
  const [row] = await sql<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "relationships" WHERE "${column}" = $1`,
    userId,
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

/** acm1r-fr-foundation.e2e-spec.ts, verbatim — RESTRICT-safe delete order. */
async function resetBootstrapState(): Promise<void> {
  for (const table of [
    'AccessControlBootstrap',
    'UserPolicies',
    'PolicyPermissions',
    'Permissions',
    'Policies',
  ]) {
    await tolerantDelete(table);
  }
}

/** acm1r-fr-foundation.e2e-spec.ts, with this suite's prefix. */
async function deleteRunUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, workEmail: true },
  });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith('s42b-tr-'))
    .map(({ id }) => id);
  if (ids.length > 0) {
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
// s42b-tr-01 — a fresh production bootstrap writes zero `Relationship` rows.
//
// The negative fact spec-4-2b-tree-root-seed.md's Intent establishes by
// reading source (`grep -in "relationship"` over `access-control-bootstrap.ts`
// and `prisma/seed.ts` → zero matches), asserted here against a LIVE database
// the real deploy chain produced.
// ───────────────────────────────────────────────────────────────────────────
describe('s42b-tr-01 · a fresh production bootstrap writes zero Relationship rows', () => {
  it('s42b-tr-01 Test · db:seed && db:bootstrap:access-control leaves "relationships" empty, whole table', async () => {
    const email = emailFor('root');

    // ── Preconditions, asserted not assumed (doc "Preconditions" 1-3): the
    // bootstrap-owned tables and this run's own namespace are clean, and the
    // whole "relationships" table is empty before either command runs.
    for (const table of [
      'Permissions',
      'Policies',
      'PolicyPermissions',
      'UserPolicies',
      'AccessControlBootstrap',
    ]) {
      expect(await countOf(table)).toBe(0);
    }
    expect(await prisma.user.count({ where: { workEmail: email } })).toBe(0);
    // CORRECTED 2026-09-06 (scenario doc s42b-tr-01, PO ruling): `relationships`
    // is not one of the five bootstrap-owned tables reset above, and nothing
    // in this suite's own preconditions clears it either — on a database with
    // any prior activity (a developer's local Postgres, not a fresh CI
    // container) this table can legitimately hold rows already. Record the
    // pre-existing count as `N` rather than asserting it is zero; the
    // durable fact this test proves is that bootstrap changes it by zero,
    // not that it starts at zero.
    const relationshipCountBefore = await countOf('relationships');

    // ── When: the real, binding deploy-order pair.
    const seed = await runSeed(email);
    expect(seed.exitCode).toBe(0);

    const root = await prisma.user.findUnique({ where: { workEmail: email } });
    expect(root).not.toBeNull();
    expect(root!.isActive).toBe(true);

    const bootstrap = await runBootstrap(email);
    expect(bootstrap.exitCode).toBe(0);
    expect(bootstrap.output).toContain(
      'Access Control bootstrap: canonical functional-role state is in place.',
    );

    // ── Then: the durable negative fact, as a delta rather than an absolute
    // state (see the correction above) — the whole-table count is unchanged,
    // because nothing in either script ever reaches the `Relationship` model
    // (spec-4-2b Intent, Code Map). The two `:rootId`-scoped queries stay
    // absolute-zero assertions regardless of `N`: `root` is a freshly created
    // id this run, so no pre-existing row (whatever `N` counts) can reference
    // it either as subject or as manager.
    expect(await countOf('relationships')).toBe(relationshipCountBefore);
    expect(await countRelationshipsWhere('userId', root!.id)).toBe(0);
    // Nothing points at root yet either, because nobody else exists.
    expect(await countRelationshipsWhere('reportsToUserId', root!.id)).toBe(0);
  });
});
