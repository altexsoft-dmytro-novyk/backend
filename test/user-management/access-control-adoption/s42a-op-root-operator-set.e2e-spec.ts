import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { SECTION_ACCESS_MATRIX } from '../../../src/access-control/domain/constants/section-access-matrix';
import type { PrismaClient, User } from '../../../src/generated/prisma/client';
import { cleanupAccessJournal } from '../epic-4/fixtures';
import { cleanupDepartures, queryDepartureRows } from '../epic-5/fixtures';
import {
  BACKEND_ROOT,
  cleanupImportedRows,
  normalizeEmail,
  rawPrisma,
  runScript,
  toDeliveredCsv,
  type ImportSummary,
  type ScriptRun,
  type SeedCsvRow,
} from '../epic-1/fixtures';
import {
  bearer,
  bootstrapTestApp,
  expectExactS1CardEnvelope,
  s1CardOf,
  type TestApp,
} from './fixtures';

/**
 * PLAT-E4-S4.2a — the root-operator permission set · AD-1 Stage 2 (red E2E,
 * written before any implementation code).
 *
 * Scenarios (one `it` per doc Test, the `s42a-op-xx` id in every title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     s42a-op-03-root-operator-capability-after-production-bootstrap.md
 *     s42a-op-04-root-data-reach-unchanged-by-the-operator-set.md
 *     s42a-op-05-delegated-hr-admin-gets-no-data-access.md
 *     s42a-op-06-delegated-hr-admin-timeline-write-accepted-deviation.md
 *
 * ── HARNESS SHAPE ────────────────────────────────────────────────────────────
 * spec-4-2a § "Open item carried into the Stage-2 gate — the harness shape",
 * RESOLVED 2026-09-06 (John, PM): build the HYBRID harness. This suite
 *   (1) provisions the database through the REAL production path as a
 *       subprocess — `db:deploy` → `db:seed` → `db:bootstrap:access-control`,
 *       reusing `epic-1/fixtures.ts`'s `runScript` (the same `execFile` on
 *       `npm run <script>` that `acm1r-fr-foundation.e2e-spec.ts` uses),
 *   (2) boots Nest via `Test.createTestingModule` against that same database
 *       (`bootstrapTestApp`, unchanged — real `AppModule`, real Prisma, no
 *       `overrideProvider`), and
 *   (3) drives the scenarios over HTTP.
 *
 * Granting the operator keys with `fx.grantFunctionalRole` and skipping the
 * script is EXPLICITLY REJECTED by that ruling: it would test the gate while
 * leaving the seed unproven, and the seed is the entire subject of this
 * increment. There is deliberately no `RunFixtures` FR grant anywhere in this
 * file — every permission a viewer holds here came out of the real bootstrap.
 * `npm run db:dev:grant-root` is NOT run, and the suite asserts it was not.
 *
 * ── ISOLATION (binding constraint of the same ruling) ────────────────────────
 * The bootstrap mutates singleton global state (root identity, the one
 * `hr-admin` FR policy) that other suites read, and `test:e2e` runs
 * `--runInBand` against one shared database. The mechanism below is
 * `acm1r-fr-foundation.e2e-spec.ts`'s, reused and NOT reinvented:
 * `resetBootstrapState()` deletes the five bootstrap-owned tables in the same
 * RESTRICT-safe order, and this suite's `users` rows carry a run-scoped,
 * suite-prefixed namespace that teardown sweeps.
 *
 * The one scoping difference, stated rather than hidden: `acm1r` resets in
 * `beforeEach` because each of its tests runs the bootstrap itself. Here the
 * bootstrap-provisioned state IS the fixture every test in the file reads, so
 * the same reset runs once in `beforeAll` (before provisioning) and once in
 * `afterAll`. Same tables, same order, same run-scoped user sweep.
 *
 * ── EXPECTED RED at `services/backend` HEAD ef03c88, in two SEPARABLE states ─
 *   (1) PRECONDITION-REPAIR RED — `package.json` has no
 *       `db:bootstrap:access-control` key (AF-1), so the bootstrap cannot be
 *       invoked by name at all. Every failure raised through
 *       `requireProvisioning()` is labelled `PRECONDITION-REPAIR RED` in its
 *       own message and proves NOTHING about the canonical set.
 *   (2) DISCRIMINATING RED — the canonical set is three keys where these
 *       scenarios need six. Its oracle is the shared precondition test
 *       (`Permissions` `3 !== 6`) and the `403 → 200/201` inversions in
 *       `s42a-op-03` Tests 2-4, `s42a-op-05` Test 4 and `s42a-op-06` Tests 1-2.
 *
 * `s42a-op-04` and the data-denial halves of `s42a-op-05` / `s42a-op-06` are
 * GREEN before AND after Stage 3 by design: a red there would mean the
 * increment widened data access, and the change stops for a human.
 *
 * ── FIXTURE RULES ────────────────────────────────────────────────────────────
 * No hardcoded placeholder id anywhere. Every uuid is read back from a row a
 * real in-suite request created: root from `users` by its normalized
 * `ROOT_WORK_EMAIL`, the employees from `POST /users/import`, the department
 * from the `Department` row that import produced, the canonical policy by its
 * natural key (`type='FR' AND targetRole='hr-admin'`) from the bootstrap's own
 * output. Sessions are `Bearer <token:<uuid>>` per the fixture convention.
 */

// The suite shells out to `db:deploy` / `db:seed` / `db:bootstrap:access-control`
// and then boots Nest; Jest's 5s default would abort provisioning before any
// test logic ran (`acm1r-fr-foundation.e2e-spec.ts` carries the same guard).
jest.setTimeout(180_000);

// ───────────────────────────────────────────────────────────────────────────
// Run-scoped namespace. The `s42a-op-` prefix is this increment's suite prefix
// (shared with test/access-control/s42a-op-bootstrap-canonical-set.e2e-spec.ts)
// so a run that dies before teardown is swept by either file's prefix sweep.
// ───────────────────────────────────────────────────────────────────────────
const runId = `s42a-op-${Date.now()}-${uuidv7()}`;
/** Marker carried by every IMPORTED row (users + departments) — not by root. */
const importMarker = `${runId}-emp`;
const ROOT_WORK_EMAIL = `${runId}-root@company.example`;

const employeeEmail = (persona: string) =>
  `${importMarker}-${persona}@x.example`;

/** The six canonical keys after PLAT-E4-S4.2a (AF-2 includes the timeline key). */
const CANONICAL_KEYS = [
  'employee:departure:record',
  'org:relationships:write',
  'profile:timeline:write',
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
] as const;

/** The two FEATURE keys the increment adds — neither may reach a section decision. */
const ADDED_FEATURE_KEYS = [
  'org:relationships:write',
  'employee:departure:record',
] as const;

/**
 * The §3.2 profile sections OTHER than `profile:identity`. At the baseline
 * commit NONE of them has a routed write surface — `users.controller.ts`,
 * `relationships.controller.ts`, `departures.controller.ts` and
 * `departments.controller.ts` declare exactly one `@RequireSectionAccess(...,
 * 'write')` route in the whole application, `PATCH /users/:id`
 * (`profile:identity`). `s42a-op-05` Test 5 and `s42a-op-06` Test 4 therefore
 * assert over the route that exists and RECORD the sections that have none,
 * rather than inventing endpoints for them (the Stage-1 flag in
 * `s42a-op-05` Test 5 says to do exactly this).
 */
const SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE = [
  'profile:leave',
  'profile:projects',
  'profile:personal-contacts',
  'profile:emergency-contacts',
  'profile:documents',
] as const;

/** The only routed section-WRITE surface at this commit. */
const ROUTED_SECTION_WRITE_SURFACE = [
  { section: 'profile:identity', method: 'PATCH', path: '/users/:id' },
] as const;

// A future `effectiveDate` — `RecordDepartureAction` rejects a non-future date
// with 400 before the capability gate's answer could ever be observed.
const DEPARTURE_EFFECTIVE_DATE = '2026-10-01';
const DEPARTURE_REASON = 'resignation';

let testApp: TestApp;
let raw: PrismaClient;

interface Provisioning {
  deploy: ScriptRun;
  seed: ScriptRun;
  bootstrap: ScriptRun;
  root: User;
  importOperators: { status: number; body: ImportSummary };
  importDelegation: { status: number; body: ImportSummary };
  /** s42a-op-03's subject and prospective manager. */
  s: User;
  m: User;
  /** The `Department` row `POST /users/import` created for S and M. */
  departmentId: string;
  /** s42a-op-05/06's delegated holder, her unrelated target, and her subject. */
  nadia: User;
  t: User;
  s2: User;
  /**
   * E4-C04c fixture only: an imported employee deactivated in-suite right
   * after import, used exclusively as the "inactive target" half of the
   * hidden-target 404 oracle for root and Nadia. Never read or written by any
   * other test in this file.
   */
  ghost: User;
}

let provisioned: Provisioning | null = null;
let provisioningDiagnosis = 'provisioning did not run';

/**
 * Separate the two red states at the point of failure. Anything that could not
 * be provisioned because the production bootstrap is unreachable fails with an
 * explicit `PRECONDITION-REPAIR RED` label, so a suite that is red on the
 * missing npm alias can never be read as evidence about the canonical set.
 */
function requireProvisioning(): Provisioning {
  if (!provisioned) {
    throw new Error(provisioningDiagnosis);
  }
  return provisioned;
}

const server = () => testApp.app.getHttpServer();

/** Multipart `POST /users/import` with one `file` part (a CSV string). */
const importCsv = (operatorId: string, csv: string) =>
  request(server())
    .post('/users/import')
    .set('authorization', bearer(operatorId))
    .attach('file', Buffer.from(csv, 'utf8'), 'population.csv');

/** A well-formed delivered-export data row for one pseudonymised employee. */
function csvRow(persona: string, overrides: SeedCsvRow = {}): SeedCsvRow {
  return {
    FirstName: 'Fixture',
    LastName: `Person-${persona}`,
    Email: employeeEmail(persona),
    Birthday: 'NULL',
    PositionId: '2',
    PositionName: 'Developer',
    RegistrationDate: '2024-01-15',
    DepartmentId: `${importMarker}-1`,
    DepartmentName: `${importMarker}-JS`,
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

const findEmployee = (persona: string) =>
  testApp.prisma.user.findUnique({
    where: { workEmail: normalizeEmail(employeeEmail(persona)) },
  });

/** `acm1r-fr-foundation.e2e-spec.ts`'s reset, verbatim (RESTRICT-safe order). */
async function resetBootstrapState(client: PrismaClient): Promise<void> {
  for (const table of [
    'AccessControlBootstrap',
    'UserPolicies',
    'PolicyPermissions',
    'Permissions',
    'Policies',
  ]) {
    try {
      await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
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
}

/** `acm1r-fr-foundation.e2e-spec.ts`'s prefix sweep, with this suite's prefix. */
async function deleteSuiteUsers(client: PrismaClient): Promise<void> {
  const users = await client.user.findMany({
    select: { id: true, workEmail: true },
  });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith('s42a-op-'))
    .map(({ id }) => id);
  if (ids.length === 0) return;
  // `users.createdBy` is a RESTRICT self-FK: the imported rows point at root,
  // so they must go first and root last.
  const rootRow = users.find(
    ({ workEmail }) => normalizeEmail(workEmail) === ROOT_WORK_EMAIL,
  );
  const dependants = ids.filter((id) => id !== rootRow?.id);
  if (dependants.length > 0) {
    await client.user.deleteMany({ where: { id: { in: dependants } } });
  }
  if (rootRow) {
    await client.user.deleteMany({ where: { id: rootRow.id } });
  }
}

const permissionKeys = async (): Promise<string[]> => {
  const rows = await testApp.prisma.$queryRawUnsafe<Array<{ key: string }>>(
    `SELECT key FROM "Permissions" ORDER BY key`,
  );
  return rows.map(({ key }) => key);
};

const countOf = async (table: string): Promise<number> => {
  const [row] = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM "${table}"`,
  );
  return Number(row.n);
};

/** Edges in EITHER direction between two people — the absence is the fixture. */
const edgesBetween = (a: string, b: string) =>
  testApp.prisma.relationship.findMany({
    where: {
      OR: [
        { userId: a, reportsToUserId: b },
        { userId: b, reportsToUserId: a },
      ],
    },
  });

const cityOf = async (userId: string): Promise<string | null | undefined> =>
  (
    await testApp.prisma.user.findUnique({
      where: { id: userId },
      select: { city: true },
    })
  )?.city;

const getUser = (targetId: string, viewerId: string) =>
  request(server())
    .get(`/users/${targetId}`)
    .set('authorization', bearer(viewerId));

const patchUser = (
  targetId: string,
  viewerId: string,
  body: Record<string, unknown>,
) =>
  request(server())
    .patch(`/users/${targetId}`)
    .set('authorization', bearer(viewerId))
    .send(body);

const postRelationship = (
  subjectId: string,
  viewerId: string,
  targetId: string,
) =>
  request(server())
    .post(`/users/${subjectId}/relationships`)
    .set('authorization', bearer(viewerId))
    .send({ type: 'direct', targetId });

// `RecordDepartureAction` requires an `Idempotency-Key` header (400 without
// one), so the header is supplied to let the CAPABILITY gate's answer be the
// thing under observation. Every call uses a fresh key — never a replay.
const postDeparture = (subjectId: string, viewerId: string) =>
  request(server())
    .post(`/users/${subjectId}/departures`)
    .set('authorization', bearer(viewerId))
    .set('Idempotency-Key', uuidv7())
    .send({
      effectiveDate: DEPARTURE_EFFECTIVE_DATE,
      reason: DEPARTURE_REASON,
    });

const putDepartmentManager = (
  deptId: string,
  viewerId: string,
  managerUserId: string,
) =>
  request(server())
    .put(`/departments/${deptId}/manager`)
    .set('authorization', bearer(viewerId))
    .send({ managerUserId });

const postEvent = (
  targetId: string,
  viewerId: string,
  body: Record<string, unknown>,
) =>
  request(server())
    .post(`/users/${targetId}/events`)
    .set('authorization', bearer(viewerId))
    .send(body);

// ───────────────────────────────────────────────────────────────────────────
// Provisioning — the production path and nothing else.
// ───────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  raw = rawPrisma();
  await resetBootstrapState(raw);
  await deleteSuiteUsers(raw);

  const deploy = await runScript('db:deploy');
  const seed = await runScript('db:seed', { ROOT_WORK_EMAIL });
  const bootstrap = await runScript('db:bootstrap:access-control', {
    ROOT_WORK_EMAIL,
  });

  testApp = await bootstrapTestApp();

  const root = await testApp.prisma.user.findUnique({
    where: { workEmail: ROOT_WORK_EMAIL },
  });

  const describeRun = (label: string, run: ScriptRun) =>
    `${label} exited ${run.exitCode}: ${run.output.trim().slice(0, 400)}`;

  if (/Missing script/i.test(bootstrap.output)) {
    provisioningDiagnosis =
      'PRECONDITION-REPAIR RED (AF-1, not the canonical-set oracle): ' +
      '`npm run db:bootstrap:access-control` is not a declared npm script, so ' +
      'the production bootstrap could not be invoked by name at all. Nothing ' +
      'downstream of it is evidence about the canonical set. See ' +
      'docs/test-cases/access-control-kernel/fr-bootstrap/' +
      's42a-op-01-bootstrap-entrypoint-npm-alias.md.';
    return;
  }
  if (
    deploy.exitCode !== 0 ||
    seed.exitCode !== 0 ||
    bootstrap.exitCode !== 0
  ) {
    provisioningDiagnosis = `PRECONDITION-REPAIR RED: the production provisioning path failed — ${describeRun('db:deploy', deploy)} | ${describeRun('db:seed', seed)} | ${describeRun('db:bootstrap:access-control', bootstrap)}`;
    return;
  }
  if (!root) {
    provisioningDiagnosis = `PRECONDITION-REPAIR RED: no active users row for the run-scoped ROOT_WORK_EMAIL "${ROOT_WORK_EMAIL}" after db:seed.`;
    return;
  }

  // Request 1 of s42a-op-03 — root creates the population through the real
  // route its `user-management:create` key gates. Two active rows, S and M.
  const importOperators = await importCsv(
    root.id,
    toDeliveredCsv([csvRow('s'), csvRow('m')]),
  );

  // The delegated-holder population of s42a-op-05 / s42a-op-06: Nadia, her
  // unrelated target T, and the subject S2 her feature keys act on. Imported by
  // root through the same real route — a second import, not a fixture insert.
  const importDelegation = await importCsv(
    root.id,
    toDeliveredCsv([
      csvRow('nadia', {
        DepartmentId: `${importMarker}-2`,
        DepartmentName: `${importMarker}-QA`,
      }),
      csvRow('t', {
        DepartmentId: `${importMarker}-2`,
        DepartmentName: `${importMarker}-QA`,
      }),
      csvRow('s2', {
        DepartmentId: `${importMarker}-2`,
        DepartmentName: `${importMarker}-QA`,
      }),
      csvRow('ghost', {
        DepartmentId: `${importMarker}-2`,
        DepartmentName: `${importMarker}-QA`,
      }),
    ]),
  );

  if (importOperators.status !== 200 || importDelegation.status !== 200) {
    provisioningDiagnosis =
      "PRECONDITION-REPAIR RED: root's `POST /users/import` returned " +
      `${importOperators.status} / ${importDelegation.status} — the bootstrap did not attach root to the ` +
      'canonical hr-admin role, so the rest of these scenarios is not ' +
      'meaningful (s42a-op-03 Test 1).';
    return;
  }

  const [s, m, nadia, t, s2, ghostImported] = await Promise.all([
    findEmployee('s'),
    findEmployee('m'),
    findEmployee('nadia'),
    findEmployee('t'),
    findEmployee('s2'),
    findEmployee('ghost'),
  ]);
  const department = await testApp.prisma.department.findFirst({
    where: { externalId: `${importMarker}-1`, name: `${importMarker}-JS` },
    select: { id: true },
  });

  if (!s || !m || !nadia || !t || !s2 || !ghostImported || !department) {
    provisioningDiagnosis =
      'PRECONDITION-REPAIR RED: the import reported success but the persisted ' +
      'rows it should have created are not readable back.';
    return;
  }

  // E4-C04c fixture only: deactivate `ghost` right after import — a real row
  // that existed, now `isActive: false`, mirroring `umac-11` Test 4's own
  // "fixture setup only" deactivation. Never touched again by any other test.
  const ghost = await testApp.prisma.user.update({
    where: { id: ghostImported.id },
    data: { isActive: false },
  });

  provisioned = {
    deploy,
    seed,
    bootstrap,
    root,
    importOperators: {
      status: importOperators.status,
      body: importOperators.body as ImportSummary,
    },
    importDelegation: {
      status: importDelegation.status,
      body: importDelegation.body as ImportSummary,
    },
    s,
    m,
    departmentId: department.id,
    nadia,
    t,
    s2,
    ghost,
  };
});

afterAll(async () => {
  if (testApp) {
    const ids = provisioned
      ? [
          provisioned.root.id,
          provisioned.s.id,
          provisioned.m.id,
          provisioned.nadia.id,
          provisioned.t.id,
          provisioned.s2.id,
          provisioned.ghost.id,
        ]
      : [];
    const steps: Array<() => Promise<unknown>> = [
      () => cleanupDepartures(testApp.prisma, ids),
      () => cleanupAccessJournal(testApp.prisma, ids),
      () =>
        testApp.prisma.relationship.deleteMany({
          where: {
            OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
          },
        }),
      // The bootstrap's own singleton global state, plus the AR
      // `unit-manager` policy s42a-op-03 Test 4 creates through the real route.
      () => resetBootstrapState(testApp.prisma),
      () => cleanupImportedRows(testApp.prisma, importMarker),
      () => deleteSuiteUsers(testApp.prisma),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn(`[${runId}] teardown step failed`, error);
      }
    }
    await testApp.app.close();
    await testApp.moduleFixture.close();
  }
  if (raw) {
    await raw.$disconnect();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Shared preconditions.
//
// Declared FIRST on purpose. The counting assertions the scenario docs carry
// (`Permissions` = 6, `UserPolicies` = 1, then = 2 after the delegation) are
// literal facts about the freshly provisioned database, and `s42a-op-03` Test 4
// legitimately adds an AR `unit-manager` attachment through the real
// `PUT /departments/:deptId/manager` route. Asserting them here — before any
// scenario write — keeps every count exactly as its doc states it, without
// weakening any of them.
// ───────────────────────────────────────────────────────────────────────────
describe('shared precondition · the production path alone provisioned this database', () => {
  it('s42a-op-03 precondition 1 · db:deploy → db:seed → db:bootstrap:access-control all exit 0 and root is readable back', () => {
    const p = requireProvisioning();
    expect(p.deploy.exitCode).toBe(0);
    expect(p.seed.exitCode).toBe(0);
    expect(p.bootstrap.exitCode).toBe(0);
    expect(normalizeEmail(p.root.workEmail)).toBe(ROOT_WORK_EMAIL);
    expect(p.root.isActive).toBe(true);
  });

  it('s42a-op-03 precondition 2 · db:dev:grant-root was NOT run — Permissions is the canonical six, not the stopgap superset, and UserPolicies holds exactly one row', async () => {
    // THE DISCRIMINATING ORACLE. At the baseline commit this fails `3 !== 6`
    // (once the AF-1 alias exists); it is the one assertion in this file that
    // measures the canonical set directly rather than through a route.
    requireProvisioning();
    expect(await permissionKeys()).toEqual([...CANONICAL_KEYS].sort());
    expect(await countOf('Permissions')).toBe(6);
    expect(await countOf('PolicyPermissions')).toBe(6);
    expect(await countOf('UserPolicies')).toBe(1);
    expect(await countOf('Policies')).toBe(1);
  });

  it('s42a-op-04 precondition · no Relationship row between root and T in either direction', async () => {
    const p = requireProvisioning();
    expect(await edgesBetween(p.root.id, p.t.id)).toEqual([]);
  });

  it('s42a-op-05 precondition · no Relationship row between Nadia and T in either direction', async () => {
    const p = requireProvisioning();
    expect(await edgesBetween(p.nadia.id, p.t.id)).toEqual([]);
  });

  describe('… and an administrator has delegated the canonical hr-admin role to Nadia', () => {
    beforeAll(async () => {
      if (!provisioned) return;
      // The ordinary administrator-shaped attachment: the policy is resolved by
      // its NATURAL KEY from the bootstrap's own output — never a literal id,
      // and never a second policy created by the fixture, because a
      // fixture-created policy would prove something other than the shipped
      // role. Fails loudly (NOT NULL on `policyId`) if the bootstrap created no
      // canonical policy, which is the honest outcome at the baseline commit.
      try {
        await testApp.prisma.$executeRawUnsafe(
          `INSERT INTO "UserPolicies" ("userId", "policyId")
           VALUES ($1, (SELECT id FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'))`,
          provisioned.nadia.id,
        );
      } catch (error) {
        console.warn(`[${runId}] delegating hr-admin to Nadia failed`, error);
      }
    });

    it('s42a-op-05 precondition · Nadia is attached to the bootstrap’s own canonical policy and UserPolicies holds exactly 2 rows', async () => {
      const p = requireProvisioning();
      const attachments = await testApp.prisma.$queryRawUnsafe<
        Array<{ userId: string; policyId: string }>
      >(
        `SELECT up."userId", up."policyId"
           FROM "UserPolicies" up
           JOIN "Policies" p ON p.id = up."policyId"
          WHERE p.type = 'FR' AND p."targetRole" = 'hr-admin'
          ORDER BY up."userId"`,
      );
      expect(attachments.map(({ userId }) => userId).sort()).toEqual(
        [p.root.id, p.nadia.id].sort(),
      );
      expect(await countOf('UserPolicies')).toBe(2);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-03 — root provisioned only by the production bootstrap can wire
// relationships and record departures.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-03 · root provisioned only by the production bootstrap can wire relationships and record departures', () => {
  it('s42a-op-03 Test 1 · root imports the population — `user-management:create` reaches its gate → 200, two employees created', () => {
    // Break caught: a 403 here means the bootstrap did not attach root to the
    // canonical role at all, and the rest of this scenario is not meaningful.
    // Also the source of every employee uuid below — no id in this file stands
    // for state that nothing created.
    const p = requireProvisioning();
    expect(p.importOperators.status).toBe(200);
    expect(p.importOperators.body).toMatchObject({
      created: 2,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(p.s.isActive).toBe(true);
    expect(p.m.isActive).toBe(true);
  });

  it('s42a-op-03 Test 2 · root wires a manager edge (`org:relationships:write`) → 201, the direct edge persisted', async () => {
    // Expected red before Stage 3: 403 — `org:relationships:write` is not in
    // the canonical set at the baseline commit and no other seeded grant
    // supplies it.
    const p = requireProvisioning();

    const res = await postRelationship(p.s.id, p.root.id, p.m.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: p.s.id,
      type: 'direct',
      reportsToUserId: p.m.id,
    });
    // Asserted against the row, not inferred from the status.
    const persisted = await testApp.prisma.relationship.findMany({
      where: { userId: p.s.id, type: 'direct' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reportsToUserId).toBe(p.m.id);
  });

  it('s42a-op-03 Test 3 · root records a departure (`employee:departure:record`) → 201, the departure persisted for S', async () => {
    // Expected red before Stage 3: 403 — `employee:departure:record` is not in
    // the canonical set at the baseline commit.
    const p = requireProvisioning();

    const res = await postDeparture(p.s.id, p.root.id);

    expect(res.status).toBe(201);
    const rows = await queryDepartureRows(testApp.prisma, p.s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.s.id, createdBy: p.root.id });
  });

  it('s42a-op-03 Test 4 · the department-manager route carries the same key → 200, M persisted as the department’s manager', async () => {
    // Included because `org:relationships:write` gates TWO controllers: a
    // canonical set that reached only relationships.controller.ts would still
    // leave a live gate closed. `<deptId>` is the row root's own import
    // produced, never written literally. Expected red before Stage 3: 403.
    const p = requireProvisioning();

    const res = await putDepartmentManager(p.departmentId, p.root.id, p.m.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      departmentId: p.departmentId,
      managerUserId: p.m.id,
    });
    const managerLinks = await testApp.prisma.userPolicy.findMany({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: p.departmentId,
          targetRole: 'unit-manager',
        },
      },
    });
    expect(managerLinks.map(({ userId }) => userId)).toEqual([p.m.id]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-04 — the grown operator set gives root no data reach it did not
// already have. GREEN before and after Stage 3; a red here at Stage 3 means the
// increment widened data access and the change stops for a human.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-04 · the grown operator set gives root no data reach it did not already have', () => {
  it('s42a-op-04 Test 1 · root cannot edit an unrelated identity card → 403, T’s row unchanged', async () => {
    // `PATCH /users/:id` is gated `@RequireSectionAccess('profile:identity',
    // 'write')`, whose audience half resolves FIRST and returns before any
    // isAllowed call. Root's edit reach comes from tree position, and
    // prisma/seed.ts writes no Relationship row anywhere.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);
  });

  it('s42a-op-04 Test 2 · root’s canEdit hint agrees with the gate → 200, canEdit false, data unchanged', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });

    const res = await getUser(p.t.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  it('s42a-op-04 Test 3 · the added feature keys are absent from every section decision', () => {
    // Structural, not a route: the claim is that neither key appears in
    // SECTION_ACCESS_MATRIX or DEFAULT_PERMISSIONS, so hasSectionAccess can
    // never consult them. A match means a feature key has entered the
    // section-access path and access-control.md line 19 is no longer
    // structurally guaranteed.
    const constantsDir = path.join(
      BACKEND_ROOT,
      'src/access-control/domain/constants',
    );
    const sources = readdirSync(constantsDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(constantsDir, file), 'utf8'));

    for (const key of ADDED_FEATURE_KEYS) {
      expect(sources.filter((source) => source.includes(key))).toEqual([]);
    }
    for (const key of ADDED_FEATURE_KEYS) {
      expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(key);
    }
  });

  // E4-C04a (test-design-epic-platform-4.md): root's own card is `self`, not
  // `reporting` — the operator set gives root no relationship row of its own
  // (s42a-op-03 precondition 2 / s42b-tr-03), so the audience over root's own
  // card resolves no higher than `self`, which §3.2 row S1 gives `R`.
  it("s42a-op-04 Test 4 · root reads its own card → 200, canEdit false (self, not reporting)", async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.root.id },
    });

    const res = await getUser(p.root.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  // E4-C04c (PM/AD-24, CONFLICT-UM-01): the hidden-target 404 oracle
  // (`umac-11-hidden-target-denial-oracle.e2e-spec.ts`) evidenced against the
  // root persona specifically — the section-access guard resolves the hidden
  // target before any section question, so root's operator-set keys (which
  // are feature keys, not section keys) are never even in play.
  it('s42a-op-04 Test 5 · root PATCH of a missing target id → 404, not 403', async () => {
    const p = requireProvisioning();

    const res = await patchUser(uuidv7(), p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
  });

  it('s42a-op-04 Test 6 · root PATCH of an inactive target → 404, not 403, row unchanged', async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.ghost.id);

    const res = await patchUser(p.ghost.id, p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
    expect(await cityOf(p.ghost.id)).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-05 — a delegated HR Admin gets zero data access from the six-key role.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-05 · a delegated HR Admin gets zero data access from the six-key role', () => {
  it('s42a-op-05 Test 1 · the delegated holder lists users → 200', async () => {
    // `user-management:list` reaches its gate through the canonical chain —
    // the delegation is real, not a fixture grant.
    const p = requireProvisioning();

    const res = await request(server())
      .get('/users')
      .set('authorization', bearer(p.nadia.id));

    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { items?: unknown[] }).items)).toBe(true);
  });

  it('s42a-op-05 Test 2 · she reads T’s card but cannot edit it → 200, canEdit false', async () => {
    // §3.2's profile:identity row gives Colleague `R`; six functional keys do
    // not turn that cell into `RW`.
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });

    const res = await getUser(p.t.id, p.nadia.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  it('s42a-op-05 Test 3 · her write is refused and the row is untouched → 403', async () => {
    // The NORMATIVE invariant (access-control.md line 19), restated for the
    // grown role: holding `profile:identity:write` implicitly through
    // DEFAULT_PERMISSIONS does not help her, because the audience half
    // resolves `read` and returns before the feature half is consulted.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);
  });

  it('s42a-op-05 Test 4 · the feature half of the role does open — relationship write and departure record both succeed', async () => {
    // Paired with Test 3 this is the whole claim of the increment: the role
    // gained feature reach and no data reach. Expected red before Stage 3:
    // both 403.
    const p = requireProvisioning();

    const relationship = await postRelationship(p.s2.id, p.nadia.id, p.t.id);
    expect(relationship.status).toBe(201);
    expect(relationship.body).toMatchObject({
      userId: p.s2.id,
      type: 'direct',
      reportsToUserId: p.t.id,
    });

    const departure = await postDeparture(p.s2.id, p.nadia.id);
    expect(departure.status).toBe(201);
    const rows = await queryDepartureRows(testApp.prisma, p.s2.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.s2.id, createdBy: p.nadia.id });
  });

  it('s42a-op-05 Test 5 · no other section opens for her — every routed section-write surface is 403 and the remaining sections have no route at all', async () => {
    // Stage-1 flag, honoured literally: the set of section write routes that
    // exists at the baseline commit is smaller than §3.2's matrix. This test
    // asserts over the routes that exist and RECORDS which sections have none,
    // rather than inventing endpoints for them.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    // (a) every routed section-write surface, driven for real.
    expect(ROUTED_SECTION_WRITE_SURFACE.map(({ section }) => section)).toEqual([
      'profile:identity',
    ]);
    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    // (b) the recorded gap: the remaining §3.2 sections have no routed write
    // surface, and none of them carries a `write` cell a colleague could reach
    // even once one is routed. `profile:personal-contacts`,
    // `profile:emergency-contacts` and `profile:documents` are not in
    // SECTION_ACCESS_MATRIX at all yet.
    for (const section of SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE) {
      expect(
        ROUTED_SECTION_WRITE_SURFACE.map((route) => route.section),
      ).not.toContain(section);
      expect(SECTION_ACCESS_MATRIX[section]?.colleague ?? 'none').not.toBe(
        'write',
      );
    }

    // (c) none of the six canonical keys is a section key.
    for (const key of CANONICAL_KEYS) {
      expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(key);
    }
  });

  // E4-C04c (PM/AD-24, CONFLICT-UM-01): the hidden-target 404 oracle
  // evidenced against the delegated HR Admin persona specifically — her six
  // canonical feature keys never reach the section decision, so a hidden
  // target is `404` for her exactly as it is for an ordinary caller.
  it('s42a-op-05 Test 6 · the delegated holder PATCHes a missing target id → 404, not 403', async () => {
    const p = requireProvisioning();

    const res = await patchUser(uuidv7(), p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
  });

  it('s42a-op-05 Test 7 · the delegated holder PATCHes an inactive target → 404, not 403, row unchanged', async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.ghost.id);

    const res = await patchUser(p.ghost.id, p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
    expect(await cityOf(p.ghost.id)).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-06 — a delegated HR Admin CAN write any employee's career timeline.
//
// A KNOWN, ACCEPTED DEVIATION from a NORMATIVE invariant, by the dated
// 2026-09-06 Product Owner ruling (AF-2). `canEditTimeline` discards its target
// (`void targetUserId`, then `isAllowed(viewer, 'profile:timeline:write')`
// alone), so seeding that key into the canonical role gives every present and
// future holder org-wide timeline write with no relationship to the target.
//
// DO NOT "FIX" THESE EXPECTATIONS BY INVERTING THEM. The scenario doc carries
// that instruction explicitly. A future increment that narrows
// `canEditTimeline` supersedes this file with a dated pointer; it does not
// rewrite it.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-06 · a delegated HR Admin can write any employee’s career timeline — a known accepted deviation', () => {
  let createdEventId: string | null = null;

  it('s42a-op-06 Test 1 · the delegated holder writes a stranger’s career timeline → 201, persisted against T', async () => {
    // Expected red before Stage 3: 403, because `profile:timeline:write` has
    // no holder at all on a pure production bootstrap at the baseline commit.
    // The red → green flip here IS the deviation being introduced.
    const p = requireProvisioning();

    const res = await postEvent(p.t.id, p.nadia.id, {
      type: 'position_change',
      eventDate: '2026-03-01',
    });

    expect(res.status).toBe(201);
    createdEventId = (res.body as { id?: string }).id ?? null;
    expect(typeof createdEventId).toBe('string');

    // Asserted against the database, not inferred from the status.
    const persisted = await testApp.prisma.userEvent.findUnique({
      where: { id: createdEventId! },
    });
    expect(persisted).toMatchObject({
      userId: p.t.id,
      type: 'position_change',
      source: 'manual',
      createdBy: p.nadia.id,
      deletedAt: null,
    });
  });

  it('s42a-op-06 Test 2 · she deletes an event on the same stranger’s timeline → 204, soft-deleted and absent from a follow-up read', async () => {
    const p = requireProvisioning();
    expect(createdEventId).not.toBeNull();

    const res = await request(server())
      .delete(`/users/${p.t.id}/events/${createdEventId}`)
      .set('authorization', bearer(p.nadia.id));

    expect(res.status).toBe(204);
    const persisted = await testApp.prisma.userEvent.findUnique({
      where: { id: createdEventId! },
    });
    expect(persisted?.deletedAt).not.toBeNull();

    // She can read the timeline back through canReadTimeline's "edit implies
    // read" fallback, and the deleted event is gone from it.
    const read = await request(server())
      .get(`/users/${p.t.id}/events`)
      .set('authorization', bearer(p.nadia.id));
    expect(read.status).toBe(200);
    expect(
      (read.body as { data: Array<{ id: string }> }).data.map(({ id }) => id),
    ).not.toContain(createdEventId);
  });

  it('s42a-op-06 Test 3 · the same viewer is still refused T’s identity card → 403 and canEdit false', async () => {
    // One section is audience-gated and closed, one is permission-gated and
    // open, for the same viewer over the same target. Putting both answers in
    // one scenario is the point. Green before and after.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const patched = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(patched.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });
    const read = await getUser(p.t.id, p.nadia.id);
    expect(read.status).toBe(200);
    expectExactS1CardEnvelope(read.body, s1CardOf(row!), false);
  });

  it('s42a-op-06 Test 4 · the deviation is bounded to the timeline — every other routed profile-section write stays 403', async () => {
    // A second open section would mean a second data-write key entered the
    // canonical set, which ACM1-FB-01 forbids. As in s42a-op-05 Test 5, the
    // assertion runs over the routes that exist and records the sections that
    // have none.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    for (const section of SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE) {
      expect(
        ROUTED_SECTION_WRITE_SURFACE.map((route) => route.section),
      ).not.toContain(section);
    }

    // `profile:timeline` is the ONLY section the canonical set can write, and
    // it reaches no section matrix row at all — which is exactly why the
    // deviation is invisible to `hasSectionAccess`.
    expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(
      'profile:timeline',
    );
  });
});
