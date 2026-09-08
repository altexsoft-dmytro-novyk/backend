import 'dotenv/config';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { PrismaClient, User } from '../../src/generated/prisma/client';
import {
  BACKEND_ROOT,
  cleanupImportedRows,
  normalizeEmail,
  POPULATION_CSV_PATH,
  rawPrisma,
  runScript,
  toDeliveredCsv,
  type ScriptRun,
  type SeedCsvRow,
} from '../user-management/epic-1/fixtures';
import {
  bearer,
  bootstrapTestApp,
  type TestApp,
} from '../user-management/access-control-adoption/fixtures';

/**
 * PLAT-E4-S4.2d — the dev seed spine (`db:dev:seed-org`) · AD-1 Stage 2, the
 * DB-level, subprocess-only suite (Ask First AF-1).
 *
 * Scenarios (one `describe` per doc, `it`s named `s42d-ds-xx Test n`):
 *   docs/test-cases/access-control-kernel/dev-seed-spine/
 *     s42d-ds-01-throws-under-node-env-production.md
 *     s42d-ds-02-two-level-spine-over-imported-population.md
 *     s42d-ds-03-rerun-is-additive-only.md
 *     s42d-ds-04-department-with-no-active-members-is-skipped.md
 *     s42d-ds-05-dev-grant-root-retired-and-create-root-repointed.md
 *
 * ── HARNESS SHAPE (AF-1: DB-level, subprocess-only; mirrors
 * `s42a-op-bootstrap-canonical-set.e2e-spec.ts` /
 * `s42b-tr-bootstrap-no-relationship-row.e2e-spec.ts` verbatim) ────────────
 * Real deploy-time entrypoints as subprocesses (`execFile` on `npm run
 * <script>`), asserted against a raw `PrismaClient`. No Nest boot anywhere in
 * this file EXCEPT the two narrow, doc-mandated exceptions below — both
 * scoped to one setup step each, opened and closed immediately, never used
 * for the discriminating assertions themselves:
 *
 *   1. s42d-ds-02/03's shared population fixture needs one real
 *      `POST /users/:id/relationships` call (an administrator pre-wiring an
 *      edge before the spine script ever runs), because that is the only
 *      write path for a `direct` edge — `s42d-ds-03`'s own Preconditions
 *      item 3 states this explicitly ("a Nest boot is required for this one
 *      step; the rest of this file's assertions stay subprocess-only against
 *      the database").
 *   2. `s42d-ds-04` Part A's zero-active-members fixture and `s42d-ds-03`
 *      Test 4's AF-4 deactivated-lead fixture both need `User.isActive:
 *      false` on an already-imported user. `DELETE /users/:id` is the only
 *      route that produces this and is itself HTTP-only; per the ruling
 *      already made for this dispatch (mirroring `s42d-ds-04`'s own Trace
 *      note), a direct, minimal `prisma.user.update({ data: { isActive:
 *      false } } )` is used as FIXTURE SETUP ONLY — never as the behaviour
 *      under test — exactly the established pattern `read-denial.e2e-spec.ts`,
 *      `s41c-section-access-gate.e2e-spec.ts`, `relationships-read.e2e-spec.ts`,
 *      `photo-v15.e2e-spec.ts` and `request-magic-link.e2e-spec.ts` already
 *      use for the same reason. No Nest boot needed for this one — it is a
 *      raw Prisma write.
 *
 * ── THE CSV-PATH WRINKLE (spec-4-2d Code Map; s42d-ds-02/06 Scenario) ──────
 * `import-population.ts` hardcodes `POPULATION_CSV_PATH` with no environment
 * override. To produce a multi-department population this suite (a) reads
 * and holds the delivered file's original bytes, (b) overwrites that same
 * real path with a suite-authored multi-row CSV, (c) runs the real
 * `npm run db:import:population` entrypoint, and (d) restores the delivered
 * file's exact original bytes — unconditionally, in a `finally`, before any
 * assertion runs, not deferred to `afterAll` — so a mid-test throw can never
 * leave the tracked fixture mutated. See `withSwappedPopulationCsv` below.
 *
 * ── ISOLATION (reused, not reinvented) ──────────────────────────────────────
 * Same five-table `resetBootstrapState()` and `s42d-ds-` prefix sweep as every
 * other suite in this family; imported rows (departments/users/etc.) are swept
 * by `cleanupImportedRows` keyed by this run's own import marker.
 *
 * ── EXPECTED RED at `services/backend` HEAD 8ec35fd ─────────────────────────
 * `scripts/dev-seed-org.ts` and the `db:dev:seed-org` npm alias do not exist —
 * every `runScript('db:dev:seed-org', ...)` call below fails with npm's own
 * "Missing script" text. `scripts/dev-grant-root.ts` still exists and
 * `create:root` still points at it — the s42d-ds-05 retirement assertions are
 * red for that reason. This is a real red-then-green story, not a lock.
 */

jest.setTimeout(300_000);

const prisma: PrismaClient = rawPrisma();
const PREFIX = 's42d-ds-';
const runId = `${PREFIX}${Date.now()}-${uuidv7()}`;
const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

// ───────────────────────────────────────────────────────────────────────────
// Generic subprocess / db helpers — same shape as
// `s42a-op-bootstrap-canonical-set.e2e-spec.ts` / `s42b-tr-...ts`.
// ───────────────────────────────────────────────────────────────────────────

const runSeed = (rootWorkEmail: string) =>
  runScript('db:seed', { ROOT_WORK_EMAIL: rootWorkEmail });

const runBootstrap = (rootWorkEmail: string) =>
  runScript('db:bootstrap:access-control', { ROOT_WORK_EMAIL: rootWorkEmail });

const runSeedOrg = (env: Record<string, string> = {}) =>
  runScript('db:dev:seed-org', env);

const runDeploy = () => runScript('db:deploy');

/**
 * Separates "the script/alias does not exist yet" (npm's own text, proves
 * nothing about the spine's behaviour) from every other red state, mirroring
 * `s42a-op-*`'s `expectBootstrapRan`. Throws with a clearly labelled message
 * on the missing-script red so it can never be mistaken for a shape/guard
 * finding.
 */
function requireSeedOrgRan(run: ScriptRun): void {
  if (/Missing script/i.test(run.output)) {
    throw new Error(
      'PRECONDITION-REPAIR RED (script/alias not built yet, not a spine ' +
        'finding): `npm run db:dev:seed-org` is not a declared npm script — ' +
        '`scripts/dev-seed-org.ts` and the alias are Stage-3 work. Nothing ' +
        `below this line is evidence about the spine's shape. npm output: ` +
        `${run.output.trim().slice(0, 300)}`,
    );
  }
}

const sql = <T = unknown>(query: string, ...params: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(query, ...params);

const execSql = (query: string, ...params: unknown[]) =>
  prisma.$executeRawUnsafe(query, ...params);

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
 * `access_journal` rows (written by `AssignManagerAction` and
 * `AddDepartmentMembershipAction` in the same transaction as their edge/
 * membership) carry RESTRICT FKs on both `subjectUserId` and `actorUserId` —
 * every row touching this run's users must go before any user row, or
 * teardown itself throws (`epic-4/fixtures.ts`'s `cleanupAccessJournal`,
 * reimplemented here against a bare `PrismaClient` rather than a
 * Nest-injected `PrismaService`, which that helper's own type requires).
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

/** `acm1r-fr-foundation.e2e-spec.ts`, verbatim — RESTRICT-safe delete order. */
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

async function deleteRunUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, workEmail: true },
  });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith(PREFIX))
    .map(({ id }) => id);
  if (ids.length === 0) return;
  // `users.createdBy` is a RESTRICT self-FK: imported rows point at root, so
  // dependants go first, root (if present) last.
  const roots = users.filter(({ workEmail }) =>
    /-root@/.test(workEmail.toLowerCase()),
  );
  const rootIds = new Set(roots.map((r) => r.id));
  const dependants = ids.filter((id) => !rootIds.has(id));
  if (dependants.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: dependants } } });
  }
  const remainingRootIds = ids.filter((id) => rootIds.has(id));
  if (remainingRootIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: remainingRootIds } } });
  }
}

async function relationshipCountWhere(
  column: 'userId' | 'reportsToUserId',
  userId: string,
): Promise<number> {
  const [row] = await sql<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "relationships" WHERE "${column}" = $1`,
    userId,
  );
  return Number(row.n);
}

interface RelRow {
  id: string;
  userId: string;
  type: string;
  reportsToUserId: string | null;
}

/** Every `relationships` row whose subject is one of `userIds`, sorted by id. */
async function relationshipRowsFor(userIds: string[]): Promise<RelRow[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<RelRow>(
    `SELECT id, "userId", type, "reportsToUserId" FROM "relationships"
      WHERE "userId" = ANY($1::text[]) ORDER BY "userId"`,
    userIds,
  );
  return rows;
}

/**
 * A department's currently active membership roster, joined to `User`,
 * ordered ascending by `User.id` — the spine's own lead-synthesis order
 * (spec Design Notes). Read back live rather than assumed from CSV row
 * order, so the assertion holds regardless of exact uuid7 generation timing.
 */
async function activeRosterOf(departmentId: string): Promise<User[]> {
  const memberships = await prisma.departmentMembership.findMany({
    where: { departmentId, validTo: null },
    select: { userId: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) }, isActive: true },
    orderBy: { id: 'asc' },
  });
  return users;
}

async function findDepartment(externalId: string, name: string) {
  return prisma.department.findFirst({
    where: { externalId, name },
    select: { id: true },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The CSV-path wrinkle. `POPULATION_CSV_PATH` is the real, tracked repo file
// (`docs/Accounts_template.csv`) — `import-population.ts` has no environment
// override. Original bytes are restored in a `finally` immediately after the
// subprocess exits, before any assertion in the caller runs — not deferred
// to `afterAll` — so a throw inside `fn` can never leave the tracked file
// mutated.
// ───────────────────────────────────────────────────────────────────────────
async function withSwappedPopulationCsv<T>(
  csv: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = fs.readFileSync(POPULATION_CSV_PATH);
  fs.writeFileSync(POPULATION_CSV_PATH, csv, 'utf8');
  try {
    return await fn();
  } finally {
    fs.writeFileSync(POPULATION_CSV_PATH, original);
  }
}

/** A well-formed delivered-export data row for one pseudonymised employee. */
function csvRow(
  persona: string,
  deptExternalId: string,
  deptName: string,
  overrides: SeedCsvRow = {},
): SeedCsvRow {
  return {
    FirstName: 'Fixture',
    LastName: `Person-${persona}`,
    Email: `${runId}-emp-${persona}@x.example`,
    Birthday: 'NULL',
    PositionId: '2',
    PositionName: 'Developer',
    RegistrationDate: '2024-01-15',
    DepartmentId: deptExternalId,
    DepartmentName: deptName,
    DismissedDate: 'NULL',
    IsDismissed: '0',
    EmployeeType: 'Employee',
    TimeZone: 'Europe/Kyiv',
    CountryId: '227',
    CountryCode: 'UA',
    CountryName: 'Ukraine',
    CountryStateId: 'NULL',
    CountryStateName: 'NULL',
    ...overrides,
  };
}

const employeeEmail = (persona: string) => `${runId}-emp-${persona}@x.example`;

const findEmployee = (persona: string) =>
  prisma.user.findUnique({
    where: { workEmail: normalizeEmail(employeeEmail(persona)) },
  });

const importMarker = `${runId}-emp`;

async function importCsvViaScript(rows: SeedCsvRow[]): Promise<ScriptRun> {
  return withSwappedPopulationCsv(toDeliveredCsv(rows), () =>
    runScript('db:import:population', {}),
  );
}

afterAll(async () => {
  // `Relationship.reportsToUserId` is a RESTRICT FK — every row targeting
  // (or subject to) one of this run's users must go before any user row,
  // or teardown itself throws and leaves the fixture for the next run.
  const runUsers = await prisma.user.findMany({
    where: { workEmail: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = runUsers.map((u) => u.id);
  // Journal before relationships before users (DEC-UM-010).
  await cleanupAccessJournalRows(ids);
  if (ids.length > 0) {
    await prisma.relationship.deleteMany({
      where: {
        OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
      },
    });
  }
  await cleanupImportedRows(prisma, importMarker);
  await resetBootstrapState();
  await deleteRunUsers();
  await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════════════
// s42d-ds-01 — throws under NODE_ENV=production, before any DB connection.
// ═══════════════════════════════════════════════════════════════════════════
describe('s42d-ds-01 · db:dev:seed-org throws under NODE_ENV=production, before any database connection', () => {
  const ROOT_WORK_EMAIL = emailFor('ds01-root');

  beforeAll(async () => {
    await resetBootstrapState();
    await runDeploy();
    const seed = await runSeed(ROOT_WORK_EMAIL);
    expect(seed.exitCode).toBe(0);
    await runBootstrap(ROOT_WORK_EMAIL);
  });

  /** This run's own scoped row-count snapshot across every table the script
   *  could plausibly touch (doc Preconditions item 3 / Test 2). */
  async function scopedSnapshot() {
    const root = await prisma.user.findUnique({
      where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
    });
    const userIds = root ? [root.id] : [];
    return {
      users: await prisma.user.count({
        where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
      }),
      memberships: await prisma.departmentMembership.count({
        where: { userId: { in: userIds } },
      }),
      relationships: await prisma.relationship.count({
        where: {
          OR: [
            { userId: { in: userIds } },
            { reportsToUserId: { in: userIds } },
          ],
        },
      }),
    };
  }

  it('s42d-ds-01 Test 1 · the guard fires and exits nonzero, naming NODE_ENV=production as the refusal reason', async () => {
    const run = await runSeedOrg({
      NODE_ENV: 'production',
      ROOT_WORK_EMAIL,
    });

    // Expected RED at Stage 2 (doc's own header): the alias does not exist,
    // so npm itself refuses before the guard is ever reached.
    requireSeedOrgRan(run);

    expect(run.exitCode).not.toBe(0);
    expect(run.output.toLowerCase()).toContain('production');
    // Not a generic unhandled-rejection stack — the diagnostic names the
    // refusal reason (doc Test 1).
    expect(run.output).not.toMatch(/unhandledrejection/i);
  });

  it('s42d-ds-01 Test 2 · no database connection is attempted — the scoped row-count snapshot is byte-identical', async () => {
    const before = await scopedSnapshot();

    const run = await runSeedOrg({
      NODE_ENV: 'production',
      ROOT_WORK_EMAIL,
    });
    requireSeedOrgRan(run);

    const after = await scopedSnapshot();
    expect(after).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// s42d-ds-02 / s42d-ds-03 — the central positive shape, and its idempotence,
// over ONE shared multi-department population (doc-03's own precondition:
// "the full seeded-population state from S4.2d-DS-02's own Preconditions").
//
// Departments, all imported through the real `db:import:population`
// entrypoint against a suite-authored CSV swapped into the real, tracked
// `docs/Accounts_template.csv` path:
//   Alpha  — 3 active members (alphaA, alphaB, alphaC), imported in that row
//            order — the general multi-member shape (doc-02 Tests 1/2).
//   Solo   — 1 active member (solo) — the single-member collapse (doc-02
//            Test 4).
//   Beta   — 2 active members (betaLead, betaMember). BEFORE the spine ever
//            runs, root wires `betaMember → root` through the real
//            `POST /users/:id/relationships` (the one Nest-booted step this
//            file uses, per doc-03's own Preconditions item 3). This is
//            deliberately a DIFFERENT target than the spine's own algorithm
//            would choose (betaMember's department lead), so the survival
//            of this exact row is real proof of "never overwritten, even
//            when it would compute something else" — not an accident of
//            the two paths agreeing (doc-03 Design Notes).
//   Gamma  — 2 active members (gammaLead, gammaMember). After the first
//            spine run, gammaLead is deactivated by a direct, minimal
//            `prisma.user.update` (fixture setup only — see file header) —
//            the AF-4 sub-scenario (doc-03 Test 4).
// A second import batch (CSV-2) adds one new member to Alpha (alphaD) and a
// brand-new department Delta (deltaLead, deltaMember) — doc-03 Test 2.
//
// NOTE on doc-02 Test 2's per-member sweep: Beta is deliberately excluded
// from the GENERAL "every non-lead member reports to their lead" assertion,
// because betaMember's row is the doc-03 administrator-write case by
// design (member → root, not member → lead) — asserting it under the
// general rule would conflate two distinct claims the docs themselves keep
// separate. Beta gets its own dedicated assertion under s42d-ds-03 instead.
// ═══════════════════════════════════════════════════════════════════════════
describe('s42d-ds-02 & s42d-ds-03 · the two-level spine over a real, multi-department population, and its idempotence', () => {
  const ROOT_WORK_EMAIL = emailFor('ds0203-root');
  let root: User;
  let testApp: TestApp | undefined;

  let alpha: { id: string };
  let solo: { id: string };
  let beta: { id: string };
  let gamma: { id: string };
  let delta: { id: string };

  let alphaA: User, alphaB: User, alphaC: User, alphaD: User;
  let soloUser: User;
  let betaLead: User, betaMember: User;
  let gammaLead: User, gammaMember: User;
  let deltaLead: User, deltaMember: User;

  /** Snapshot of every relationship row for this run's own users, by id. */
  const snapshotAll = () =>
    relationshipRowsFor(
      [
        alphaA,
        alphaB,
        alphaC,
        soloUser,
        betaLead,
        betaMember,
        gammaLead,
        gammaMember,
      ]
        .filter(Boolean)
        .map((u) => u.id),
    );

  beforeAll(async () => {
    await resetBootstrapState();

    await runDeploy();
    const seed = await runSeed(ROOT_WORK_EMAIL);
    expect(seed.exitCode).toBe(0);
    const bootstrap = await runBootstrap(ROOT_WORK_EMAIL);
    expect(bootstrap.exitCode).toBe(0);

    const foundRoot = await prisma.user.findUnique({
      where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
    });
    if (!foundRoot) {
      throw new Error(
        'PRECONDITION-REPAIR RED: no root User row after db:seed for ' +
          `"${ROOT_WORK_EMAIL}".`,
      );
    }
    root = foundRoot;

    // ── CSV-1: Alpha (3), Solo (1), Beta (2), Gamma (2) ────────────────────
    const dept = (persona: string) => `${importMarker}-${persona}`;
    const csv1 = [
      csvRow('alphaA', dept('alpha'), `${importMarker}-Alpha`),
      csvRow('alphaB', dept('alpha'), `${importMarker}-Alpha`),
      csvRow('alphaC', dept('alpha'), `${importMarker}-Alpha`),
      csvRow('solo', dept('solo'), `${importMarker}-Solo`),
      csvRow('betaLead', dept('beta'), `${importMarker}-Beta`),
      csvRow('betaMember', dept('beta'), `${importMarker}-Beta`),
      csvRow('gammaLead', dept('gamma'), `${importMarker}-Gamma`),
      csvRow('gammaMember', dept('gamma'), `${importMarker}-Gamma`),
    ];
    const import1 = await importCsvViaScript(csv1);
    if (import1.exitCode !== 0) {
      throw new Error(
        `PRECONDITION-REPAIR RED: db:import:population (CSV-1) exited ` +
          `${import1.exitCode}: ${import1.output.trim().slice(0, 400)}`,
      );
    }

    [
      alphaA,
      alphaB,
      alphaC,
      soloUser,
      betaLead,
      betaMember,
      gammaLead,
      gammaMember,
    ] = (await Promise.all(
      [
        'alphaA',
        'alphaB',
        'alphaC',
        'solo',
        'betaLead',
        'betaMember',
        'gammaLead',
        'gammaMember',
      ].map(findEmployee),
    )) as User[];
    for (const [persona, u] of [
      ['alphaA', alphaA],
      ['alphaB', alphaB],
      ['alphaC', alphaC],
      ['solo', soloUser],
      ['betaLead', betaLead],
      ['betaMember', betaMember],
      ['gammaLead', gammaLead],
      ['gammaMember', gammaMember],
    ] as const) {
      if (!u) {
        throw new Error(
          `PRECONDITION-REPAIR RED: imported user "${persona}" not readable back.`,
        );
      }
    }

    const [alphaDept, soloDept, betaDept, gammaDept] = await Promise.all([
      findDepartment(dept('alpha'), `${importMarker}-Alpha`),
      findDepartment(dept('solo'), `${importMarker}-Solo`),
      findDepartment(dept('beta'), `${importMarker}-Beta`),
      findDepartment(dept('gamma'), `${importMarker}-Gamma`),
    ]);
    if (!alphaDept || !soloDept || !betaDept || !gammaDept) {
      throw new Error(
        'PRECONDITION-REPAIR RED: one or more imported departments not readable back.',
      );
    }
    alpha = alphaDept;
    solo = soloDept;
    beta = betaDept;
    gamma = gammaDept;

    // ── The one Nest-booted step in this file (doc-03 Preconditions item 3):
    // root wires betaMember → root DIRECTLY, bypassing the spine entirely,
    // BEFORE the spine ever runs. Booted here so it is ready for the
    // "shared precondition" test immediately below.
    testApp = await bootstrapTestApp();
  });

  afterAll(async () => {
    if (testApp) {
      await testApp.app.close();
      await testApp.moduleFixture.close();
    }
  });

  it('shared precondition · root wires betaMember → root via the real POST /users/:id/relationships route, before any spine run', async () => {
    if (!testApp)
      throw new Error('Nest app not booted for the admin pre-wire step.');
    const res = await request(testApp.app.getHttpServer())
      .post(`/users/${betaMember.id}/relationships`)
      .set('authorization', bearer(root.id))
      .send({ type: 'direct', targetId: root.id });

    expect(res.status).toBe(201);
    const persisted = await prisma.relationship.findMany({
      where: { userId: betaMember.id, type: 'direct' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reportsToUserId).toBe(root.id);
  });

  it("shared precondition · no relationship row exists for any of this run's imported users before the first spine run", async () => {
    const rows = await relationshipRowsFor(
      [alphaA, alphaB, alphaC, soloUser, gammaLead, gammaMember].map(
        (u) => u.id,
      ),
    );
    expect(rows).toEqual([]);
  });

  // ─── run 1: the first invocation of db:dev:seed-org ──────────────────────
  describe('run 1 · the initial spine over the imported population', () => {
    beforeAll(async () => {
      const run = await runSeedOrg({ ROOT_WORK_EMAIL });
      requireSeedOrgRan(run);
      expect(run.exitCode).toBe(0);
    });

    it('s42d-ds-02 Test 1 · one edge per department lead, straight to root', async () => {
      for (const dept of [alpha, solo, beta, gamma]) {
        const roster = await activeRosterOf(dept.id);
        expect(roster.length).toBeGreaterThan(0);
        const lead = roster[0];
        const edge = await prisma.relationship.findFirst({
          where: { userId: lead.id, type: 'direct' },
        });
        expect(edge).toMatchObject({ reportsToUserId: root.id });
      }
      // Root itself never appears as a lead's edge target's target — no
      // other row targets a lead except the department's own members
      // (checked in Test 2).
    });

    it("s42d-ds-02 Test 2 · every other active member of Alpha and Gamma reports to their own department's lead", async () => {
      for (const dept of [alpha, gamma]) {
        const roster = await activeRosterOf(dept.id);
        const [lead, ...others] = roster;
        for (const member of others) {
          const edge = await prisma.relationship.findFirst({
            where: { userId: member.id, type: 'direct' },
          });
          expect(edge).toMatchObject({ reportsToUserId: lead.id });
        }
      }
    });

    it('s42d-ds-02 Test 3 · root never becomes a subject', async () => {
      expect(await relationshipCountWhere('userId', root.id)).toBe(0);
    });

    it('s42d-ds-02 Test 4 · the single-member department (Solo) collapses lead and member into exactly one edge', async () => {
      const rows = await prisma.relationship.findMany({
        where: { userId: soloUser.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: root.id,
      });
    });

    it("s42d-ds-02 Test 5 · exact row-count accounting for this run's namespace", async () => {
      // 4 departments with ≥1 active member (Alpha, Solo, Beta, Gamma) +
      // active non-lead members (alphaB, alphaC, betaMember, gammaMember) = 8.
      // betaMember's row is the pre-wired administrator edge, not written by
      // the script — the total count claim is agnostic to who wrote it
      // (doc-03 Design Notes), so it is included in the formula.
      const rows = await relationshipRowsFor(
        [
          alphaA,
          alphaB,
          alphaC,
          soloUser,
          betaLead,
          betaMember,
          gammaLead,
          gammaMember,
        ].map((u) => u.id),
      );
      expect(rows).toHaveLength(8);
    });

    it('s42d-ds-03 Test 3 · the administrator-written betaMember → root edge survives the first spine run untouched', async () => {
      const rows = await prisma.relationship.findMany({
        where: { userId: betaMember.id },
      });
      expect(rows).toHaveLength(1);
      // NOT betaLead — the spine's own algorithm would have chosen betaLead;
      // the administrator's edge is never overwritten.
      expect(rows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: root.id,
      });

      // And betaLead — who held no edge before run 1 — was filled in normally.
      const leadRows = await prisma.relationship.findMany({
        where: { userId: betaLead.id },
      });
      expect(leadRows).toHaveLength(1);
      expect(leadRows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: root.id,
      });
    });
  });

  // ─── AF-4 fixture: deactivate Gamma's lead, between run 1 and run 2 ──────
  describe('AF-4 fixture · gammaLead is deactivated by a direct, minimal Prisma write (fixture setup only)', () => {
    it('gammaLead.isActive is confirmed false by a direct read before the rerun', async () => {
      await prisma.user.update({
        where: { id: gammaLead.id },
        data: { isActive: false },
      });
      const row = await prisma.user.findUnique({ where: { id: gammaLead.id } });
      expect(row?.isActive).toBe(false);
    });
  });

  // ─── run 2: a rerun with NO new population import ────────────────────────
  describe('run 2 · a rerun with no new population import', () => {
    let beforeSnapshot: RelRow[] = [];

    beforeAll(async () => {
      beforeSnapshot = await snapshotAll();
      const run = await runSeedOrg({ ROOT_WORK_EMAIL });
      requireSeedOrgRan(run);
      expect(run.exitCode).toBe(0);
    });

    it('s42d-ds-03 Test 1 · zero new rows — every row is byte-identical to the pre-rerun snapshot', async () => {
      const after = await snapshotAll();
      expect(after).toEqual(beforeSnapshot);
    });

    it('s42d-ds-03 Test 4 · Gamma is not auto-repaired (AF-4) — gammaMember still reports to the now-inactive former lead', async () => {
      const rows = await prisma.relationship.findMany({
        where: { userId: gammaMember.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: gammaLead.id,
      });
      // No new row was created for Gamma as a side effect of the deactivation.
      const gammaLeadRows = await prisma.relationship.findMany({
        where: { userId: gammaLead.id },
      });
      expect(gammaLeadRows).toHaveLength(1);
    });
  });

  // ─── run 3: a rerun after a new population-import batch ──────────────────
  describe('run 3 · a rerun after a new population-import batch', () => {
    let beforeSnapshot: RelRow[] = [];

    beforeAll(async () => {
      beforeSnapshot = await snapshotAll();

      const dept = (persona: string) => `${importMarker}-${persona}`;
      const csv2 = [
        // Re-import Alpha (same externalId/name) with a NEW member.
        csvRow('alphaA', dept('alpha'), `${importMarker}-Alpha`),
        csvRow('alphaB', dept('alpha'), `${importMarker}-Alpha`),
        csvRow('alphaC', dept('alpha'), `${importMarker}-Alpha`),
        csvRow('alphaD', dept('alpha'), `${importMarker}-Alpha`),
        // A brand-new department.
        csvRow('deltaLead', dept('delta'), `${importMarker}-Delta`),
        csvRow('deltaMember', dept('delta'), `${importMarker}-Delta`),
      ];
      const import2 = await importCsvViaScript(csv2);
      if (import2.exitCode !== 0) {
        throw new Error(
          `PRECONDITION-REPAIR RED: db:import:population (CSV-2) exited ` +
            `${import2.exitCode}: ${import2.output.trim().slice(0, 400)}`,
        );
      }

      [alphaD, deltaLead, deltaMember] = (await Promise.all(
        ['alphaD', 'deltaLead', 'deltaMember'].map(findEmployee),
      )) as User[];
      for (const [persona, u] of [
        ['alphaD', alphaD],
        ['deltaLead', deltaLead],
        ['deltaMember', deltaMember],
      ] as const) {
        if (!u) {
          throw new Error(
            `PRECONDITION-REPAIR RED: imported user "${persona}" (CSV-2) not readable back.`,
          );
        }
      }
      const deltaDept = await findDepartment(
        dept('delta'),
        `${importMarker}-Delta`,
      );
      if (!deltaDept) {
        throw new Error(
          'PRECONDITION-REPAIR RED: department Delta not readable back.',
        );
      }
      delta = deltaDept;

      const run = await runSeedOrg({ ROOT_WORK_EMAIL });
      requireSeedOrgRan(run);
      expect(run.exitCode).toBe(0);
    });

    it('s42d-ds-03 Test 2 · new edges exist only for the new department and the newly-added Alpha member', async () => {
      // alphaD reports to Alpha's existing lead (unchanged by the new import).
      const alphaRoster = await activeRosterOf(alpha.id);
      const alphaLead = alphaRoster[0];
      const alphaDRows = await prisma.relationship.findMany({
        where: { userId: alphaD.id },
      });
      expect(alphaDRows).toHaveLength(1);
      expect(alphaDRows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: alphaLead.id,
      });

      // Delta gets its own two-level shape.
      const deltaRoster = await activeRosterOf(delta.id);
      const [deltaExpectedLead, ...deltaOthers] = deltaRoster;
      const deltaLeadRows = await prisma.relationship.findMany({
        where: { userId: deltaExpectedLead.id },
      });
      expect(deltaLeadRows).toHaveLength(1);
      expect(deltaLeadRows[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: root.id,
      });
      for (const member of deltaOthers) {
        const rows = await prisma.relationship.findMany({
          where: { userId: member.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'direct',
          reportsToUserId: deltaExpectedLead.id,
        });
      }

      // Every row from run 1 + run 2 is untouched.
      const after = await snapshotAll();
      expect(after).toEqual(beforeSnapshot);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// s42d-ds-04 — a department with zero active members is skipped (Part A),
// and an empty population seeds nothing (Part B).
// ═══════════════════════════════════════════════════════════════════════════
describe('s42d-ds-04 · a department with zero active members is skipped, and an empty population seeds nothing', () => {
  describe('Part A · a department with zero active members', () => {
    const ROOT_WORK_EMAIL = emailFor('ds04a-root');
    let zetaMember: User;

    beforeAll(async () => {
      await resetBootstrapState();
      await runDeploy();
      const seed = await runSeed(ROOT_WORK_EMAIL);
      expect(seed.exitCode).toBe(0);
      await runBootstrap(ROOT_WORK_EMAIL);

      const dept = `${importMarker}-zeta`;
      const csv = [csvRow('zeta', dept, `${importMarker}-Zeta`)];
      const imported = await importCsvViaScript(csv);
      if (imported.exitCode !== 0) {
        throw new Error(
          `PRECONDITION-REPAIR RED: db:import:population (Zeta) exited ` +
            `${imported.exitCode}: ${imported.output.trim().slice(0, 400)}`,
        );
      }

      const found = await findEmployee('zeta');
      if (!found) {
        throw new Error(
          'PRECONDITION-REPAIR RED: imported user "zeta" not readable back.',
        );
      }
      zetaMember = found;

      // Fixture setup only (file header note): a direct, minimal Prisma
      // write — not `DELETE /users/:id`, and not the behaviour under test.
      await prisma.user.update({
        where: { id: zetaMember.id },
        data: { isActive: false },
      });
      const confirmed = await prisma.user.findUnique({
        where: { id: zetaMember.id },
      });
      expect(confirmed?.isActive).toBe(false);
    });

    it('s42d-ds-04 Test 1 · the all-inactive department is skipped without error', async () => {
      const run = await runSeedOrg({ ROOT_WORK_EMAIL });
      requireSeedOrgRan(run);
      expect(run.exitCode).toBe(0);

      expect(await relationshipCountWhere('userId', zetaMember.id)).toBe(0);
      expect(
        await relationshipCountWhere('reportsToUserId', zetaMember.id),
      ).toBe(0);
    });
  });

  describe('Part B · a fresh database with no population imported at all', () => {
    // Not a fresh CI container — this is a shared local Postgres other
    // suites also use (s42b-tr-01's own precedent for the same reason). A
    // literal `SELECT count(*) FROM users` = 0 cannot be asserted safely
    // here; instead every claim is scoped to this run's own ROOT_WORK_EMAIL
    // namespace, which the real db:seed step provisions freshly regardless
    // of what else exists in the shared database.
    const ROOT_WORK_EMAIL = emailFor('ds04b-root');

    it("s42d-ds-04 Test 2 · an empty database (this run's own namespace) seeds nothing and reports success, not error", async () => {
      await resetBootstrapState();
      const preCount = await prisma.user.count({
        where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
      });
      expect(preCount).toBe(0);

      await runDeploy();
      const seed = await runSeed(ROOT_WORK_EMAIL);
      expect(seed.exitCode).toBe(0);
      const bootstrap = await runBootstrap(ROOT_WORK_EMAIL);
      expect(bootstrap.exitCode).toBe(0);

      const root = await prisma.user.findUnique({
        where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
      });
      if (!root) {
        throw new Error(
          'PRECONDITION-REPAIR RED: no root User row after db:seed.',
        );
      }
      expect(root.isActive).toBe(true);

      // `db:import:population` is deliberately NOT run for this part.
      const run = await runSeedOrg({ ROOT_WORK_EMAIL });
      requireSeedOrgRan(run);
      expect(run.exitCode).toBe(0);
      expect(run.output.toLowerCase()).toMatch(/nothing to seed|zero depart/);

      expect(await relationshipCountWhere('userId', root.id)).toBe(0);
      expect(await relationshipCountWhere('reportsToUserId', root.id)).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// s42d-ds-05 — dev-grant-root.ts is retired, create:root is repointed, and
// the one orphaned permission key is left alone (AF-2).
// ═══════════════════════════════════════════════════════════════════════════
describe('s42d-ds-05 · dev-grant-root.ts is retired in full, and create:root is repointed', () => {
  it('s42d-ds-05 Test 1 · scripts/dev-grant-root.ts no longer exists on disk', () => {
    // Expected RED at Stage 2 — the file still exists at HEAD 8ec35fd.
    expect(fs.existsSync(`${BACKEND_ROOT}/scripts/dev-grant-root.ts`)).toBe(
      false,
    );
  });

  it("s42d-ds-05 Test 2 · npm run db:dev:grant-root fails with npm's own Missing script text, not this project's own diagnostic", async () => {
    // Expected RED at Stage 2 — the alias still exists and dev-grant-root.ts
    // still runs (and fails on its OWN diagnostic, not npm's "Missing
    // script" text, because nothing has retired it yet).
    const run = await runScript('db:dev:grant-root', {});
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/Missing script/i);
  });

  it("s42d-ds-05 Test 3 · create:root's value is the exact repointed chain", () => {
    // Expected RED at Stage 2 — the current value still points at
    // db:dev:grant-root.
    //
    // CORRECTED 2026-09-07 (Dmytro Novyk, PO, after a Stage-3 code review):
    // the original spec chained `db:dev:seed-org` onto `create:root` as a
    // third step. That is a real ordering defect, not a style choice —
    // `db:dev:seed-org` operates over the IMPORTED population
    // (`DepartmentMembership` rows), and neither `create:root` nor its
    // predecessor ever ran `db:import:population`. Bundled as a third step,
    // `db:dev:seed-org` always ran against zero memberships and silently
    // logged "nothing to seed" — the org-spine feature this whole increment
    // exists to deliver never actually fired in the intended
    // create:root → sign in → import workflow, with no error and no
    // documented extra step to make it fire. `create:root` is reverted to
    // seed + bootstrap only, exactly matching what it did before this
    // increment for root-creation and root-permission purposes.
    // `db:dev:seed-org` remains a standalone script, run by hand whenever an
    // org chart is wanted, any time after `db:import:population`.
    const pkg = JSON.parse(
      readFileSync(`${BACKEND_ROOT}/package.json`, 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['create:root']).toBe(
      'npm run db:seed && npm run db:bootstrap:access-control',
    );
  });

  describe('s42d-ds-05 Test 4 · create:root actually runs the repointed chain end to end', () => {
    const ROOT_WORK_EMAIL = emailFor('ds05t4-root');

    it('exits 0, provisions root through the canonical six-key chain, and leaves relationships at 0 for this run', async () => {
      await resetBootstrapState();
      await runDeploy();

      // Expected RED at Stage 2: `create:root`'s CURRENT value runs
      // `db:dev:grant-root` (dev-grant-root.ts), never
      // `db:bootstrap:access-control` or `db:dev:seed-org` — so the
      // canonical six-key set this test looks for will not be there.
      const run = await runScript('create:root', { ROOT_WORK_EMAIL });
      expect(run.exitCode).toBe(0);

      const root = await prisma.user.findUnique({
        where: { workEmail: normalizeEmail(ROOT_WORK_EMAIL) },
      });
      if (!root) {
        throw new Error(
          'PRECONDITION-REPAIR RED: no root User row after npm run create:root.',
        );
      }

      const permissionRows = await sql<{ key: string }>(
        `SELECT key FROM "Permissions" ORDER BY key`,
      );
      expect(permissionRows.map((r) => r.key)).toEqual(
        [
          'employee:departure:record',
          'org:relationships:write',
          'profile:timeline:write',
          'user-management:create',
          'user-management:deactivate',
          'user-management:list',
        ].sort(),
      );

      expect(await relationshipCountWhere('userId', root.id)).toBe(0);
    });
  });

  describe('s42d-ds-05 Test 5 · a database carrying the pre-existing orphaned user-management:edit key is left untouched (AF-2)', () => {
    const ROOT_WORK_EMAIL = emailFor('ds05t5-root');
    let orphanPermissionId: string;
    let hrAdminPolicyId: string;

    beforeAll(async () => {
      await resetBootstrapState();
      await runDeploy();
      const seed = await runSeed(ROOT_WORK_EMAIL);
      expect(seed.exitCode).toBe(0);

      // Simulate "a pre-existing dev database that already ran the old
      // dev-grant-root.ts" by seeding the equivalent rows directly — one of
      // the two Stage-2 approaches the scenario doc itself names, chosen
      // here because checking out the pre-retirement script is not
      // practical inside one e2e file. Real Prisma client calls (not raw
      // SQL id-generation) so this run's `AccessControlBootstrap` row shape
      // matches every other fixture in this suite family.
      const permission = await prisma.permission.create({
        data: {
          key: `${runId}-user-management:edit`,
          description: 'Edit any employee identity card (S1), including own.',
        },
      });
      orphanPermissionId = permission.id;

      const policy = await prisma.policy.create({
        data: {
          operator: '==',
          targetType: null,
          targetId: null,
          targetRole: 'hr-admin',
          type: 'FR',
          managedBy: 'admin',
        },
      });
      hrAdminPolicyId = policy.id;

      await prisma.policyPermission.create({
        data: {
          policyId: hrAdminPolicyId,
          permissionId: orphanPermissionId,
          policyType: 'FR',
        },
      });
    });

    it('the orphaned Permissions row and its grant survive a bootstrap rerun, byte-identical', async () => {
      const before = await sql<{ id: string; description: string | null }>(
        `SELECT id, description FROM "Permissions" WHERE id = $1`,
        orphanPermissionId,
      );

      const bootstrap = await runBootstrap(ROOT_WORK_EMAIL);
      expect(bootstrap.exitCode).toBe(0);

      const after = await sql<{ id: string; description: string | null }>(
        `SELECT id, description FROM "Permissions" WHERE id = $1`,
        orphanPermissionId,
      );
      expect(after).toEqual(before);

      const grantStillPresent = await sql<{ n: bigint }>(
        `SELECT count(*)::bigint AS n FROM "PolicyPermissions"
          WHERE "policyId" = $1 AND "permissionId" = $2`,
        hrAdminPolicyId,
        orphanPermissionId,
      );
      expect(Number(grantStillPresent[0].n)).toBe(1);

      // The canonical six keys are also present (restored if missing).
      const canonicalPresent = await sql<{ n: bigint }>(
        `SELECT count(*)::bigint AS n FROM "Permissions"
          WHERE key = ANY($1::text[])`,
        [
          'employee:departure:record',
          'org:relationships:write',
          'profile:timeline:write',
          'user-management:create',
          'user-management:deactivate',
          'user-management:list',
        ],
      );
      expect(Number(canonicalPresent[0].n)).toBe(6);
    });
  });
});
