import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { PrismaClient, User } from '../../../src/generated/prisma/client';
import { cleanupAccessJournal } from '../epic-4/fixtures';
import { cleanupDepartures } from '../epic-5/fixtures';
import {
  cleanupImportedRows,
  normalizeEmail,
  rawPrisma,
  runScript,
  toDeliveredCsv,
  type ImportSummary,
  type ScriptRun,
  type SeedCsvRow,
} from '../epic-1/fixtures';
import { bearer, bootstrapTestApp, type TestApp } from './fixtures';

/**
 * Shared provisioning + HTTP-helper module for the two `s42a-op-root-operator-
 * set` e2e files (`s42a-op-root-operator-set.e2e-spec.ts` — `s42a-op-03`/`04`
 * — and `s42a-op-05-delegated-hr-admin.e2e-spec.ts` — `s42a-op-05`/`06`).
 * Extracted (H5, test-review-plat-e2-e4-2026-09-13.md) so splitting the
 * original 1339-line file did not mean duplicating ~450 lines of identical
 * setup into each half. Jest gives each `*.e2e-spec.ts` file its own,
 * independent module registry, so the module-level state below (`runId`,
 * `testApp`, `provisioned`) is a fresh, unshared instance per SPEC FILE, not
 * per process — the two spec files never see each other's `provisioned`
 * object, and each runs its own `db:deploy` → `db:seed` →
 * `db:bootstrap:access-control` subprocess against its own run-scoped
 * namespace. This mirrors how both spec files already import shared,
 * stateless helpers from `./fixtures.ts` / `../epic-1/fixtures.ts` — the only
 * difference is that the exports here happen to close over mutable state,
 * exactly once per importing file.
 *
 * See `s42a-op-root-operator-set.e2e-spec.ts`'s own header comment for the
 * full HYBRID-harness rationale, the isolation mechanism, and the two
 * SEPARABLE red states — not repeated here.
 */

// The suite shells out to `db:deploy` / `db:seed` / `db:bootstrap:access-control`
// and then boots Nest; Jest's 5s default would abort provisioning before any
// test logic ran (`acm1r-fr-foundation.e2e-spec.ts` carries the same guard).
// Each importing spec file must still call `jest.setTimeout(180_000)` itself
// — a config call has no effect from inside an imported module.

/** The six canonical keys after PLAT-E4-S4.2a (AF-2 includes the timeline key). */
export const CANONICAL_KEYS = [
  'employee:departure:record',
  'org:relationships:write',
  'profile:timeline:write',
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
] as const;

/** The two FEATURE keys the increment adds — neither may reach a section decision. */
export const ADDED_FEATURE_KEYS = [
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
export const SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE = [
  'profile:leave',
  'profile:projects',
  'profile:personal-contacts',
  'profile:emergency-contacts',
  'profile:documents',
] as const;

/** The only routed section-WRITE surface at this commit. */
export const ROUTED_SECTION_WRITE_SURFACE = [
  { section: 'profile:identity', method: 'PATCH', path: '/users/:id' },
] as const;

// A future `effectiveDate` — `RecordDepartureAction` rejects a non-future date
// with 400 before the capability gate's answer could ever be observed.
const DEPARTURE_EFFECTIVE_DATE = '2026-10-01';
const DEPARTURE_REASON = 'resignation';

// ───────────────────────────────────────────────────────────────────────────
// Run-scoped namespace. The `s42a-op-` prefix is this increment's suite prefix
// (shared with test/access-control/s42a-op-bootstrap-canonical-set.e2e-spec.ts
// and BOTH files importing this module) so a run that dies before teardown is
// swept by any of those files' prefix sweep.
// ───────────────────────────────────────────────────────────────────────────
export const runId = `s42a-op-${Date.now()}-${uuidv7()}`;
/** Marker carried by every IMPORTED row (users + departments) — not by root. */
export const importMarker = `${runId}-emp`;
export const ROOT_WORK_EMAIL = `${runId}-root@company.example`;

const employeeEmail = (persona: string) =>
  `${importMarker}-${persona}@x.example`;

export let testApp: TestApp;
let raw: PrismaClient;

export interface Provisioning {
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
  /** The `Department` row `POST /users/import` created for Nadia/T/S2 (QA). */
  qaDepartmentId: string;
  /**
   * E4-C04c fixture only: an imported employee deactivated in-suite right
   * after import, used exclusively as the "inactive target" half of the
   * hidden-target 404 oracle for root and Nadia. Never read or written by any
   * other test in the importing file.
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
export function requireProvisioning(): Provisioning {
  if (!provisioned) {
    throw new Error(provisioningDiagnosis);
  }
  return provisioned;
}

/**
 * Non-throwing variant for a `beforeAll` that wants to no-op (rather than
 * fail the suite) when provisioning did not succeed — mirrors the original
 * in-file `if (!provisioned) return;` guard.
 */
export function getProvisioned(): Provisioning | null {
  return provisioned;
}

/**
 * The ordinary administrator-shaped attachment behind `s42a-op-05`/`06`:
 * Nadia is attached to the bootstrap's own canonical `hr-admin` FR policy,
 * resolved by its NATURAL KEY — never a literal id, and never a
 * fixture-created second policy, because that would prove something other
 * than the shipped role. Fails loudly (NOT NULL on `policyId`) if the
 * bootstrap created no canonical policy, which is the honest outcome at the
 * baseline commit.
 *
 * Called unconditionally from `s42a-op-05-delegated-hr-admin.e2e-spec.ts`'s
 * own top-level `beforeAll` (NOT from a nested `describe`'s `beforeAll`):
 * Jest only runs a `describe` block's own `beforeAll` when that block
 * contains at least one test matching the current run (including a
 * `--testNamePattern` / `-t` filter), so gating this mutation behind one
 * `it`'s own parent describe made every OTHER test in the file silently
 * depend on that unrelated precondition test being selected too — invisible
 * on a full-file run, but a live `403` instead of the expected `200`/`201`
 * under `-t "s42a-op-05 Test <n>"` (H4, test-review-plat-e2-e4-2026-09-13.md).
 * `s42a-op-root-operator-set.e2e-spec.ts` (the `s42a-op-03`/`04` sibling)
 * never calls this — its own precondition asserts `UserPolicies` stays at
 * exactly 1 (root only).
 */
export async function delegateHrAdminToNadia(): Promise<void> {
  const p = getProvisioned();
  if (!p) return;
  try {
    await testApp.prisma.$executeRawUnsafe(
      `INSERT INTO "UserPolicies" ("userId", "policyId")
       VALUES ($1, (SELECT id FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'))`,
      p.nadia.id,
    );
  } catch (error) {
    console.warn(`[${runId}] delegating hr-admin to Nadia failed`, error);
  }
}

export const server = () => testApp.app.getHttpServer();

/** Multipart `POST /users/import` with one `file` part (a CSV string). */
export const importCsv = (operatorId: string, csv: string) =>
  request(server())
    .post('/users/import')
    .set('authorization', bearer(operatorId))
    .attach('file', Buffer.from(csv, 'utf8'), 'population.csv');

/** A well-formed delivered-export data row for one pseudonymised employee. */
export function csvRow(
  persona: string,
  overrides: SeedCsvRow = {},
): SeedCsvRow {
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

export const findEmployee = (persona: string) =>
  testApp.prisma.user.findUnique({
    where: { workEmail: normalizeEmail(employeeEmail(persona)) },
  });

/** `acm1r-fr-foundation.e2e-spec.ts`'s reset, verbatim (RESTRICT-safe order). */
export async function resetBootstrapState(client: PrismaClient): Promise<void> {
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
export async function deleteSuiteUsers(client: PrismaClient): Promise<void> {
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

export const permissionKeys = async (): Promise<string[]> => {
  const rows = await testApp.prisma.$queryRawUnsafe<Array<{ key: string }>>(
    `SELECT key FROM "Permissions" ORDER BY key`,
  );
  return rows.map(({ key }) => key);
};

export const countOf = async (table: string): Promise<number> => {
  const [row] = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM "${table}"`,
  );
  return Number(row.n);
};

/** Edges in EITHER direction between two people — the absence is the fixture. */
export const edgesBetween = (a: string, b: string) =>
  testApp.prisma.relationship.findMany({
    where: {
      OR: [
        { userId: a, reportsToUserId: b },
        { userId: b, reportsToUserId: a },
      ],
    },
  });

export const cityOf = async (
  userId: string,
): Promise<string | null | undefined> =>
  (
    await testApp.prisma.user.findUnique({
      where: { id: userId },
      select: { city: true },
    })
  )?.city;

export const getUser = (targetId: string, viewerId: string) =>
  request(server())
    .get(`/users/${targetId}`)
    .set('authorization', bearer(viewerId));

export const patchUser = (
  targetId: string,
  viewerId: string,
  body: Record<string, unknown>,
) =>
  request(server())
    .patch(`/users/${targetId}`)
    .set('authorization', bearer(viewerId))
    .send(body);

export const postRelationship = (
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
export const postDeparture = (subjectId: string, viewerId: string) =>
  request(server())
    .post(`/users/${subjectId}/departures`)
    .set('authorization', bearer(viewerId))
    .set('Idempotency-Key', uuidv7())
    .send({
      effectiveDate: DEPARTURE_EFFECTIVE_DATE,
      reason: DEPARTURE_REASON,
    });

export const putDepartmentManager = (
  deptId: string,
  viewerId: string,
  managerUserId: string,
) =>
  request(server())
    .put(`/departments/${deptId}/manager`)
    .set('authorization', bearer(viewerId))
    .send({ managerUserId });

export const postEvent = (
  targetId: string,
  viewerId: string,
  body: Record<string, unknown>,
) =>
  request(server())
    .post(`/users/${targetId}/events`)
    .set('authorization', bearer(viewerId))
    .send(body);

// ── E4-C04b fixture-only helpers: the remaining routes gated by the
// canonical `hr-admin` FEATURE keys (`org:relationships:write`,
// `employee:departure:record`, `user-management:create`,
// `user-management:deactivate`), beyond the two each already exercised by
// s42a-op-03/05. Every one carries the identical `@RequireFeature` +
// `AccessControlGuard` mechanism as its already-tested sibling. ──────────────

export const putPeoplePartner = (
  employeeId: string,
  viewerId: string,
  targetId: string,
) =>
  request(server())
    .put(`/users/${employeeId}/relationships/people-partner`)
    .set('authorization', bearer(viewerId))
    .send({ targetId });

export const deletePeoplePartner = (employeeId: string, viewerId: string) =>
  request(server())
    .delete(`/users/${employeeId}/relationships/people-partner`)
    .set('authorization', bearer(viewerId));

export const deleteRelationship = (
  employeeId: string,
  relationshipId: string,
  viewerId: string,
) =>
  request(server())
    .delete(`/users/${employeeId}/relationships/${relationshipId}`)
    .set('authorization', bearer(viewerId));

export const postDepartmentMembership = (
  employeeId: string,
  viewerId: string,
  departmentId: string,
) =>
  request(server())
    .post(`/users/${employeeId}/departments`)
    .set('authorization', bearer(viewerId))
    .send({ departmentId });

export const deleteDepartmentMembership = (
  employeeId: string,
  departmentId: string,
  viewerId: string,
) =>
  request(server())
    .delete(`/users/${employeeId}/departments/${departmentId}`)
    .set('authorization', bearer(viewerId));

export const deleteDepartmentManager = (deptId: string, viewerId: string) =>
  request(server())
    .delete(`/departments/${deptId}/manager`)
    .set('authorization', bearer(viewerId));

export const deactivateUser = (targetId: string, viewerId: string) =>
  request(server())
    .delete(`/users/${targetId}`)
    .set('authorization', bearer(viewerId));

export const getDeparture = (
  employeeId: string,
  departureId: string,
  viewerId: string,
) =>
  request(server())
    .get(`/users/${employeeId}/departures/${departureId}`)
    .set('authorization', bearer(viewerId));

// ───────────────────────────────────────────────────────────────────────────
// Provisioning — the production path and nothing else. Call from the
// importing spec file's own `beforeAll`.
// ───────────────────────────────────────────────────────────────────────────
export async function provisionRootOperatorFixtures(): Promise<void> {
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
  const qaDepartment = await testApp.prisma.department.findFirst({
    where: { externalId: `${importMarker}-2`, name: `${importMarker}-QA` },
    select: { id: true },
  });

  if (
    !s ||
    !m ||
    !nadia ||
    !t ||
    !s2 ||
    !ghostImported ||
    !department ||
    !qaDepartment
  ) {
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
    qaDepartmentId: qaDepartment.id,
    ghost,
  };
}

/**
 * Teardown — call from the importing spec file's own `afterAll`. `label`
 * (each file's own `describe`-block comment context) only affects the
 * console warning prefix on a failed step.
 */
export async function teardownRootOperatorFixtures(): Promise<void> {
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
      // The bootstrap's own singleton global state, plus any AR
      // `unit-manager` policy the importing file's own tests created through
      // the real `PUT /departments/:deptId/manager` route.
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
}
