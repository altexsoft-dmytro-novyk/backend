import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { PrismaClient, User } from '../../../src/generated/prisma/client';
import { cleanupAccessJournal } from '../epic-4/fixtures';
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
import {
  bearer,
  bootstrapTestApp,
  expectExactS1CardEnvelope,
  s1CardOf,
  type TestApp,
} from './fixtures';

/**
 * PLAT-E4-S4.2b — tree-root seed · AD-1 Stage 2, HTTP-level suite (AF-3
 * split).
 *
 * Scenarios (one `it` per doc Test, the `s42b-tr-0x` id in every title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     s42b-tr-02-root-resolves-reporting-write-two-levels-down.md
 *     s42b-tr-03-root-has-no-upward-edge.md
 *     s42b-tr-04-unrelated-and-colleague-reach-into-root-unchanged.md
 *
 * ── HARNESS SHAPE (spec-4-2b-tree-root-seed.md, Ask First AF-3, Code Map §
 * "Precedent harnesses this spec's e2e reuses, not reinvents") ─────────────
 * Mirrors `s42a-op-root-operator-set.e2e-spec.ts` exactly: (1) provisions the
 * database through the REAL production path as a subprocess — `db:deploy` →
 * `db:seed` → `db:bootstrap:access-control` (`db:dev:grant-root` is NOT run),
 * (2) boots Nest via `Test.createTestingModule` against that same database
 * (`bootstrapTestApp`, real `AppModule`, real Prisma, no `overrideProvider`),
 * and (3) drives every scenario over HTTP.
 *
 * CRITICAL CONSTRAINT (spec Boundaries & Constraints; scenario docs' own
 * Trace sections): the two-level chain `E2 → E1 → root` is wired by TWO REAL
 * `POST /users/:id/relationships` calls against employees a real
 * `POST /users/import` created — never `fixtures.ts`'s `RunFixtures.reportsTo`
 * (a raw `prisma.relationship.create` that would bypass the very write route
 * this proof exists to exercise). There is deliberately no `RunFixtures`
 * import anywhere in this file.
 *
 * ── ISOLATION (same ruling, reused and NOT reinvented) ──────────────────────
 * `resetBootstrapState()` deletes the five bootstrap-owned tables in the same
 * RESTRICT-safe order; this suite's `users` rows carry a run-scoped,
 * suite-prefixed namespace (`s42b-tr-`) that teardown sweeps. The reset runs
 * once in `beforeAll` (before provisioning) and once in `afterAll`, exactly
 * like the `s42a-op-*` precedent, because the bootstrap-provisioned state IS
 * the fixture every test in this file reads.
 *
 * ── EXPECTED GREEN ON FIRST RUN (spec-4-2b Boundaries & Constraints, "State
 * plainly ... that no red state is expected for the positive-fact suite") ──
 * This is a regression lock over an already-correct property — the six-key
 * canonical set 4.2a shipped already includes `org:relationships:write`, and
 * the upward-walk CTE (`prisma-relationship-graph.adapter.ts`) is unmodified
 * and already correct. Nothing here is a red-to-green story.
 *
 * ── FIXTURE RULES ────────────────────────────────────────────────────────────
 * No hardcoded placeholder id anywhere. Root is read back from `users` by its
 * normalized `ROOT_WORK_EMAIL`; E1/E2/U are read back from the rows the real
 * `POST /users/import` calls create. Every reporting edge is created by a real
 * `POST /users/:id/relationships` call, never a fixture insert. Sessions are
 * `Bearer <token:<uuid>>` per the fixture convention.
 */

// The suite shells out to `db:deploy` / `db:seed` / `db:bootstrap:access-control`
// and then boots Nest; Jest's 5s default would abort provisioning before any
// test logic ran (`acm1r-fr-foundation.e2e-spec.ts` carries the same guard).
jest.setTimeout(180_000);

// ───────────────────────────────────────────────────────────────────────────
// Run-scoped namespace. The `s42b-tr-` prefix is this increment's suite
// prefix (shared with
// test/access-control/s42b-tr-bootstrap-no-relationship-row.e2e-spec.ts) so a
// run that dies before teardown is swept by either file's prefix sweep.
// ───────────────────────────────────────────────────────────────────────────
const runId = `s42b-tr-${Date.now()}-${uuidv7()}`;
/** Marker carried by every IMPORTED row (users + departments) — not by root. */
const importMarker = `${runId}-emp`;
const ROOT_WORK_EMAIL = `${runId}-root@company.example`;

const employeeEmail = (persona: string) =>
  `${importMarker}-${persona}@x.example`;

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

let testApp: TestApp;
let raw: PrismaClient;

interface Provisioning {
  deploy: ScriptRun;
  seed: ScriptRun;
  bootstrap: ScriptRun;
  root: User;
  /** s42b-tr-02 Test 1 — E1 and E2, the two-level chain's employees. */
  importEmployees: { status: number; body: ImportSummary };
  e1: User;
  e2: User;
  /** s42b-tr-04 precondition 1 — U, a second real import call, no edge anywhere. */
  importU: { status: number; body: ImportSummary };
  u: User;
}

let provisioned: Provisioning | null = null;
let provisioningDiagnosis = 'provisioning did not run';

/**
 * Separate a precondition failure from a scenario failure at the point of
 * failure, mirroring `s42a-op-root-operator-set.e2e-spec.ts`'s
 * `requireProvisioning()`. Every scenario in this file is expected GREEN on
 * first run (spec Boundaries & Constraints); this guard exists so an
 * unreachable production bootstrap is never mistaken for a finding about the
 * tree-root property itself.
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
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith('s42b-tr-'))
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

/** Edges in EITHER direction touching any of `ids` — the absence is a fixture. */
const edgesInvolving = (ids: string[]) =>
  testApp.prisma.relationship.findMany({
    where: {
      OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
    },
  });

const relationshipsWhereUserId = (userId: string) =>
  testApp.prisma.relationship.count({ where: { userId } });

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

/** `POST /users/:subjectId/relationships` — the real write route under test. */
const postRelationship = (
  subjectId: string,
  viewerId: string,
  targetId: string,
) =>
  request(server())
    .post(`/users/${subjectId}/relationships`)
    .set('authorization', bearer(viewerId))
    .send({ type: 'direct', targetId });

/** `GET /users/:subjectId/relationships` — the real read route under test. */
const getRelationships = (subjectId: string, viewerId: string) =>
  request(server())
    .get(`/users/${subjectId}/relationships`)
    .set('authorization', bearer(viewerId));

// ───────────────────────────────────────────────────────────────────────────
// Provisioning — the production path and nothing else. `db:dev:grant-root` is
// never run.
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
      'PRECONDITION-REPAIR RED: `npm run db:bootstrap:access-control` is not ' +
      'a declared npm script, so the production bootstrap could not be ' +
      'invoked by name at all. Nothing downstream of it is evidence about ' +
      'the tree-root property.';
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

  // s42b-tr-02 Test 1 — root creates the population through the real route
  // (`user-management:create`), producing the two-level chain's employees.
  const importEmployees = await importCsv(
    root.id,
    toDeliveredCsv([csvRow('e1'), csvRow('e2')]),
  );

  // s42b-tr-04 precondition 1 — a SECOND real import call for U, kept separate
  // from the Test-1 call above so that call's own "two created employees"
  // assertion stays exactly what the s42b-tr-02 doc states (the doc's own
  // alternative: "a second real POST /users/import call").
  const importU = await importCsv(root.id, toDeliveredCsv([csvRow('u')]));

  if (importEmployees.status !== 200 || importU.status !== 200) {
    provisioningDiagnosis =
      "PRECONDITION-REPAIR RED: root's `POST /users/import` returned " +
      `${importEmployees.status} / ${importU.status} — the bootstrap did not ` +
      'attach root to the canonical hr-admin role, so the rest of these ' +
      'scenarios is not meaningful (s42b-tr-02 Test 1).';
    return;
  }

  const [e1, e2, u] = await Promise.all([
    findEmployee('e1'),
    findEmployee('e2'),
    findEmployee('u'),
  ]);

  if (!e1 || !e2 || !u) {
    provisioningDiagnosis =
      'PRECONDITION-REPAIR RED: the import reported success but the persisted ' +
      'rows it should have created are not readable back.';
    return;
  }

  provisioned = {
    deploy,
    seed,
    bootstrap,
    root,
    importEmployees: {
      status: importEmployees.status,
      body: importEmployees.body as ImportSummary,
    },
    e1,
    e2,
    importU: { status: importU.status, body: importU.body as ImportSummary },
    u,
  };
});

afterAll(async () => {
  if (testApp) {
    const ids = provisioned
      ? [
          provisioned.root.id,
          provisioned.e1.id,
          provisioned.e2.id,
          provisioned.u.id,
        ]
      : [];
    const steps: Array<() => Promise<unknown>> = [
      // `AssignManagerAction`'s writer commits one `AccessJournal` row
      // (`kind: 'manager'`) in the same transaction as each `direct` edge
      // (`org-relationship.repository.ts`) — journal before relationships
      // before users (DEC-UM-010), or the `users` RESTRICT FK on
      // `access_journal.subjectUserId` blocks teardown.
      () => cleanupAccessJournal(testApp.prisma, ids),
      () =>
        testApp.prisma.relationship.deleteMany({
          where: {
            OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
          },
        }),
      // The bootstrap's own singleton global state.
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
// ───────────────────────────────────────────────────────────────────────────
describe('shared precondition · the production path alone provisioned this database', () => {
  it('precondition 1 · db:deploy → db:seed → db:bootstrap:access-control all exit 0, root is readable back, and db:dev:grant-root was NOT run', async () => {
    const p = requireProvisioning();
    expect(p.deploy.exitCode).toBe(0);
    expect(p.seed.exitCode).toBe(0);
    expect(p.bootstrap.exitCode).toBe(0);
    expect(normalizeEmail(p.root.workEmail)).toBe(ROOT_WORK_EMAIL);
    expect(p.root.isActive).toBe(true);

    // The canonical six-key set (4.2a), including `org:relationships:write` —
    // the FR key this file's chain-wiring calls depend on. Not the
    // `db:dev:grant-root` stopgap superset.
    expect(await permissionKeys()).toEqual(
      [
        'employee:departure:record',
        'org:relationships:write',
        'profile:timeline:write',
        'user-management:create',
        'user-management:deactivate',
        'user-management:list',
      ].sort(),
    );
    expect(await countOf('UserPolicies')).toBe(1);
  });

  it('precondition 2 · no Relationship row exists anywhere involving root, E1, E2, or U before any write in this file', async () => {
    const p = requireProvisioning();
    expect(await edgesInvolving([p.root.id, p.e1.id, p.e2.id, p.u.id])).toEqual(
      [],
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42b-tr-02 — root resolves `reporting` write two levels down a real chain
// that terminates at it.
// ───────────────────────────────────────────────────────────────────────────
describe('s42b-tr-02 · root resolves reporting write two levels down a real chain that terminates at it', () => {
  it('s42b-tr-02 Test 1 · root imports the population — E1 and E2 exist', () => {
    const p = requireProvisioning();
    expect(p.importEmployees.status).toBe(200);
    expect(p.importEmployees.body).toMatchObject({
      created: 2,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(p.e1.isActive).toBe(true);
    expect(p.e2.isActive).toBe(true);
  });

  it('s42b-tr-02 Test 2 · root wires E1 to itself (E1 → root, the first hop)', async () => {
    const p = requireProvisioning();

    const res = await postRelationship(p.e1.id, p.root.id, p.root.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: p.e1.id,
      type: 'direct',
      reportsToUserId: p.root.id,
    });
    // Asserted against the row, not inferred from the status. Root itself
    // never becomes a subject (`userId`) of any row in this file.
    const persisted = await testApp.prisma.relationship.findMany({
      where: { userId: p.e1.id, type: 'direct' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reportsToUserId).toBe(p.root.id);
    expect(await relationshipsWhereUserId(p.root.id)).toBe(0);
  });

  it('s42b-tr-02 Test 3 · root wires E2 to E1 (E2 → E1, the second hop — the chain now terminates at root)', async () => {
    const p = requireProvisioning();

    const res = await postRelationship(p.e2.id, p.root.id, p.e1.id);

    expect(res.status).toBe(201);
    const persisted = await testApp.prisma.relationship.findMany({
      where: { userId: p.e2.id, type: 'direct' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reportsToUserId).toBe(p.e1.id);

    // The chain E2 → E1 → root now exists as two real rows, and only two.
    expect(await edgesInvolving([p.e1.id, p.e2.id])).toHaveLength(2);
    // Root gains no row of its own from this or any prior step.
    expect(await relationshipsWhereUserId(p.root.id)).toBe(0);
  });

  it('s42b-tr-02 Test 4 · root edits E2, two levels down, through the unmodified upward-walk CTE', async () => {
    const p = requireProvisioning();

    const res = await patchUser(p.e2.id, p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(200);
    expect(await cityOf(p.e2.id)).toBe('Berlin');
  });

  it('s42b-tr-02 Test 5 · a follow-up read agrees: canEdit true, two levels down', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.e2.id },
    });

    const res = await getUser(p.e2.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), true);
    expect((res.body as { data: { city: string } }).data.city).toBe('Berlin');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42b-tr-03 — root's own upward walk is empty, over the real endpoint.
// ───────────────────────────────────────────────────────────────────────────
describe("s42b-tr-03 · root's own upward walk is empty, over the real endpoint", () => {
  it('precondition · no Relationship row where userId = root, immediately before the request', async () => {
    const p = requireProvisioning();
    expect(await relationshipsWhereUserId(p.root.id)).toBe(0);
  });

  it('s42b-tr-03 Test · root reads its own relationship list → 200, data: []', async () => {
    const p = requireProvisioning();

    const res = await getRelationships(p.root.id, p.root.id);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object)).toEqual(['data']);
    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42b-tr-04 — nothing about reaching INTO root moved. Green before and after
// the (possibly empty) implementation stage; a red here would mean this
// increment widened someone's reach into root.
// ───────────────────────────────────────────────────────────────────────────
describe('s42b-tr-04 · nothing about reaching into root moved — an unrelated employee and a colleague inside root’s own chain', () => {
  it('precondition 1 · U was imported by a real POST /users/import call and has no Relationship row anywhere', async () => {
    const p = requireProvisioning();
    expect(p.importU.status).toBe(200);
    expect(p.importU.body).toMatchObject({
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(p.u.isActive).toBe(true);
    expect(await edgesInvolving([p.u.id])).toEqual([]);
  });

  it("precondition 2 · E1's only edge points AT root, never received FROM root", async () => {
    const p = requireProvisioning();
    const edges = await testApp.prisma.relationship.findMany({
      where: { userId: p.e1.id },
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      userId: p.e1.id,
      type: 'direct',
      reportsToUserId: p.root.id,
    });
    // No row the other way — root never became E1's subordinate anywhere.
    expect(
      await testApp.prisma.relationship.count({
        where: { userId: p.root.id, reportsToUserId: p.e1.id },
      }),
    ).toBe(0);
  });

  it("s42b-tr-04 Test 1 · E1, whose own edge points at root, still cannot edit root's card → 403", async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.root.id);

    const res = await patchUser(p.root.id, p.e1.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.root.id)).toBe(before);
  });

  it("s42b-tr-04 Test 2 · E1 reads root's card → 200, canEdit false", async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.root.id },
    });

    const res = await getUser(p.root.id, p.e1.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  it("s42b-tr-04 Test 3 · U, with no edge anywhere, cannot edit root's card either → 403", async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.root.id);

    const res = await patchUser(p.root.id, p.u.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.root.id)).toBe(before);
  });

  it("s42b-tr-04 Test 4 · U reads root's card → 200, canEdit false", async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.root.id },
    });

    const res = await getUser(p.root.id, p.u.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });
});
