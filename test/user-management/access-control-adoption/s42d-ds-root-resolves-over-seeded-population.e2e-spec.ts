import * as fs from 'node:fs';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { PrismaClient, User } from '../../../src/generated/prisma/client';
import { cleanupAccessJournal } from '../epic-4/fixtures';
import {
  cleanupImportedRows,
  normalizeEmail,
  POPULATION_CSV_PATH,
  rawPrisma,
  runScript,
  toDeliveredCsv,
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
 * PLAT-E4-S4.2d — root resolves `reporting` write over a real, script-produced
 * spine · AD-1 Stage 2, HTTP-level suite (Ask First AF-1).
 *
 * Scenario:
 *   docs/test-cases/user-management/access-control-adoption/
 *     s42d-ds-06-root-resolves-reporting-write-over-every-seeded-member.md
 *
 * Plus, per this dispatch's own ruling (Stage-1 flagged this, the ruling was
 * made for Stage 2): the ONE AF-5 tie-break assertion
 * (`s42d-ds-02-two-level-spine-over-imported-population.md`'s own "A user
 * holds two concurrent DepartmentMembership rows" row) lives HERE, not in the
 * DB-level `dev-seed-spine/` folder, because producing the second concurrent
 * membership needs the real, HTTP-only `POST /users/:id/departments` route
 * (`add-department-membership.action.ts`, reachable only through
 * `relationships.controller.ts`), which does not fit a subprocess-only file.
 * This file already boots Nest for `s42d-ds-06`, so it is the natural home.
 *
 * ── HARNESS SHAPE (mirrors `s42a-op-root-operator-set.e2e-spec.ts` /
 * `s42b-tr-root-tree-position.e2e-spec.ts` exactly) ─────────────────────────
 * (1) provisions the database through the REAL production path as a
 *     subprocess — `db:deploy` → `db:seed` → `db:bootstrap:access-control`,
 * (2) runs the real `npm run db:import:population` entrypoint against a
 *     suite-authored multi-department CSV swapped into the real, tracked
 *     `docs/Accounts_template.csv` path (restored unconditionally — see the
 *     CSV-path wrinkle note below),
 * (3) runs the real `npm run db:dev:seed-org` entrypoint — no
 *     `POST /users/:id/relationships` call anywhere in this file's OWN
 *     setup for the `s42d-ds-06` population; every `reports-to` edge this
 *     file reads was written by the script,
 * (4) boots Nest via `Test.createTestingModule` against that same database,
 * (5) drives every `s42d-ds-06` scenario over HTTP.
 *
 * The AF-5 fixture is the one deliberate exception to point (3): it uses a
 * real `POST /users/:id/departments` call (a Nest-boot HTTP write, not a
 * `Relationship` write) to give one user a second concurrent
 * `DepartmentMembership` row BEFORE `db:dev:seed-org` runs — that department
 * membership, not a reporting edge, is the thing under test for that one
 * assertion.
 *
 * ── THE CSV-PATH WRINKLE (spec-4-2d Code Map; s42d-ds-02/06 Scenario) ──────
 * Same mechanism as `s42d-ds-dev-seed-spine.e2e-spec.ts`: `import-population.ts`
 * hardcodes `POPULATION_CSV_PATH` with no environment override. The delivered
 * file's original bytes are captured, the real tracked path is overwritten
 * with a suite-authored CSV, `npm run db:import:population` is run against
 * it, and the original bytes are restored in a `finally` — unconditionally,
 * before any assertion runs.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 * `resetBootstrapState()` deletes the five bootstrap-owned tables; this
 * suite's `users` rows carry the `s42d-ds-` run-scoped prefix shared with
 * `s42d-ds-dev-seed-spine.e2e-spec.ts`, swept by either file's teardown.
 *
 * ── EXPECTED RED at `services/backend` HEAD 8ec35fd ─────────────────────────
 * `scripts/dev-seed-org.ts` and `db:dev:seed-org` do not exist — the
 * provisioning step itself fails with npm's "Missing script" text, so every
 * scenario in this file is red on that precondition, not on the audience
 * resolution claim.
 */

jest.setTimeout(300_000);

const PREFIX = 's42d-ds-';
const runId = `${PREFIX}${Date.now()}-${uuidv7()}`;
const importMarker = `${runId}-emp`;
const ROOT_WORK_EMAIL = `${runId}-root@company.example`;

const employeeEmail = (persona: string) =>
  `${importMarker}-${persona}@x.example`;

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
    Email: employeeEmail(persona),
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

let testApp: TestApp;
let raw: PrismaClient;

interface Provisioning {
  deploy: ScriptRun;
  seed: ScriptRun;
  bootstrap: ScriptRun;
  root: User;
  importRun: ScriptRun;
  seedOrgRun: ScriptRun;
  /** s42d-ds-06's sample trio. */
  lead: User;
  member: User;
  solo: User;
  /** AF-5 tie-break fixture. */
  tieUser: User;
  tieColleague: User;
  tieDeptA: { id: string };
  tieDeptB: { id: string };
}

let provisioned: Provisioning | null = null;
let provisioningDiagnosis = 'provisioning did not run';

/**
 * Separates precondition failure from a scenario finding, mirroring
 * `s42a-op-root-operator-set.e2e-spec.ts`'s `requireProvisioning()`.
 */
function requireProvisioning(): Provisioning {
  if (!provisioned) {
    throw new Error(provisioningDiagnosis);
  }
  return provisioned;
}

const server = () => testApp.app.getHttpServer();

const findEmployee = (persona: string) =>
  testApp.prisma.user.findUnique({
    where: { workEmail: normalizeEmail(employeeEmail(persona)) },
  });

const findDepartment = (externalId: string, name: string) =>
  testApp.prisma.department.findFirst({
    where: { externalId, name },
    select: { id: true },
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
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith(PREFIX))
    .map(({ id }) => id);
  if (ids.length === 0) return;
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

/**
 * The CSV-path wrinkle: overwrite the real, tracked `docs/Accounts_template.csv`,
 * run the real import entrypoint, restore the original bytes in a `finally` —
 * unconditionally, before the caller's own error (if any) propagates.
 */
async function importViaSwappedCsv(rows: SeedCsvRow[]): Promise<ScriptRun> {
  const original = fs.readFileSync(POPULATION_CSV_PATH);
  fs.writeFileSync(POPULATION_CSV_PATH, toDeliveredCsv(rows), 'utf8');
  try {
    return await runScript('db:import:population', {});
  } finally {
    fs.writeFileSync(POPULATION_CSV_PATH, original);
  }
}

const getUser = (targetId: string, viewerId: string) =>
  request(server())
    .get(`/users/${targetId}`)
    .set('authorization', bearer(viewerId));

/** `POST /users/:id/departments` — the real "plain add" write path
 *  (`add-department-membership.action.ts`) the AF-5 fixture needs. */
const postDepartmentMembership = (
  subjectId: string,
  viewerId: string,
  departmentId: string,
) =>
  request(server())
    .post(`/users/${subjectId}/departments`)
    .set('authorization', bearer(viewerId))
    .send({ departmentId });

// ───────────────────────────────────────────────────────────────────────────
// Provisioning — the production path, the real importer, and the real
// (not-yet-existing) db:dev:seed-org, in that order.
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

  // ── the multi-department population (s42d-ds-06 Scenario) ────────────────
  //   Lead3  — 3 active members (leadA=lead, leadB/leadC=ordinary members).
  //   Solo   — 1 active member (its own lead, one hop to root).
  //   TieA   — 1 active member (tieUser) at import time.
  //   TieB   — 1 active member (tieColleague) at import time; tieUser gets a
  //            SECOND concurrent membership here via a real POST, below.
  const dept = (persona: string) => `${importMarker}-${persona}`;
  const importRun = await importViaSwappedCsv([
    csvRow('leadA', dept('lead3'), `${importMarker}-Lead3`),
    csvRow('leadB', dept('lead3'), `${importMarker}-Lead3`),
    csvRow('leadC', dept('lead3'), `${importMarker}-Lead3`),
    csvRow('solo', dept('solo'), `${importMarker}-Solo`),
    csvRow('tieUser', dept('tieA'), `${importMarker}-TieA`),
    csvRow('tieColleague', dept('tieB'), `${importMarker}-TieB`),
  ]);
  if (importRun.exitCode !== 0) {
    provisioningDiagnosis = `PRECONDITION-REPAIR RED: db:import:population failed — ${describeRun('db:import:population', importRun)}`;
    return;
  }

  const [leadA, leadB, leadC, solo, tieUser, tieColleague] = await Promise.all([
    findEmployee('leadA'),
    findEmployee('leadB'),
    findEmployee('leadC'),
    findEmployee('solo'),
    findEmployee('tieUser'),
    findEmployee('tieColleague'),
  ]);
  const [lead3Dept, tieDeptA, tieDeptB] = await Promise.all([
    findDepartment(dept('lead3'), `${importMarker}-Lead3`),
    findDepartment(dept('tieA'), `${importMarker}-TieA`),
    findDepartment(dept('tieB'), `${importMarker}-TieB`),
  ]);
  if (
    !leadA ||
    !leadB ||
    !leadC ||
    !solo ||
    !tieUser ||
    !tieColleague ||
    !lead3Dept ||
    !tieDeptA ||
    !tieDeptB
  ) {
    provisioningDiagnosis =
      'PRECONDITION-REPAIR RED: the import reported success but the persisted ' +
      'rows it should have created are not readable back.';
    return;
  }

  // Determined by a live read, not assumed from CSV row order (the spec's
  // own "ascending User.id == CSV row order" claim is a fact about uuid7
  // generation this suite does not need to re-verify to stay correct): the
  // Lead3 roster ordered ascending by id — index 0 is the department's own
  // synthesized lead, any other index is a genuine two-hop ordinary member.
  const lead3Roster = [leadA, leadB, leadC].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const [dept3Lead, dept3Member] = lead3Roster;

  // ── AF-5 fixture: a real "plain add" (`POST /users/:id/departments`, no
  // `fromDepartmentId`) gives tieUser a SECOND concurrent
  // `DepartmentMembership` — BEFORE db:dev:seed-org ever runs. Requires
  // `org:relationships:write`, held by root through the canonical bootstrap.
  const addMembership = await postDepartmentMembership(
    tieUser.id,
    root.id,
    tieDeptB.id,
  );
  if (addMembership.status !== 201) {
    provisioningDiagnosis =
      "PRECONDITION-REPAIR RED: the AF-5 fixture's " +
      `POST /users/${tieUser.id}/departments returned ${addMembership.status} ` +
      '— tieUser does not hold two concurrent DepartmentMembership rows, so ' +
      'the tie-break assertion is not meaningful.';
    return;
  }
  const tieMembershipCount = await testApp.prisma.departmentMembership.count({
    where: { userId: tieUser.id, validTo: null },
  });
  if (tieMembershipCount !== 2) {
    provisioningDiagnosis =
      `PRECONDITION-REPAIR RED: tieUser holds ${tieMembershipCount} current ` +
      'DepartmentMembership row(s), expected exactly 2 for the AF-5 fixture.';
    return;
  }

  // ── the real, not-yet-existing spine script ───────────────────────────────
  const seedOrgRun = await runScript('db:dev:seed-org', { ROOT_WORK_EMAIL });
  if (/Missing script/i.test(seedOrgRun.output)) {
    provisioningDiagnosis =
      'PRECONDITION-REPAIR RED (script/alias not built yet, not an ' +
      'audience-resolution finding): `npm run db:dev:seed-org` is not a ' +
      'declared npm script — `scripts/dev-seed-org.ts` and the alias are ' +
      "Stage-3 work. Nothing below this line is evidence about root's " +
      `reporting reach. npm output: ${seedOrgRun.output.trim().slice(0, 300)}`;
    return;
  }
  if (seedOrgRun.exitCode !== 0) {
    provisioningDiagnosis = `PRECONDITION-REPAIR RED: db:dev:seed-org failed — ${describeRun('db:dev:seed-org', seedOrgRun)}`;
    return;
  }

  provisioned = {
    deploy,
    seed,
    bootstrap,
    root,
    importRun,
    seedOrgRun,
    lead: dept3Lead,
    member: dept3Member,
    solo,
    tieUser,
    tieColleague,
    tieDeptA,
    tieDeptB,
  };
});

afterAll(async () => {
  if (testApp) {
    // Every user this run created (not just the sampled trio the fixture
    // tracks — `leadC`, the Lead3 roster member neither `lead` nor `member`
    // point at, still holds a relationship row that must go before it can
    // be deleted), read back by the shared run prefix.
    const runUsers = await testApp.prisma.user.findMany({
      where: { workEmail: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = runUsers.map((u) => u.id);
    const steps: Array<() => Promise<unknown>> = [
      // Journal before relationships before users (DEC-UM-010) — both
      // `AssignManagerAction` (relationship writes) and
      // `AddDepartmentMembershipAction` (the AF-5 fixture's membership write)
      // commit an `access_journal` row in the same transaction as their edge.
      () => cleanupAccessJournal(testApp.prisma, ids),
      () =>
        testApp.prisma.relationship.deleteMany({
          where: {
            OR: [{ userId: { in: ids } }, { reportsToUserId: { in: ids } }],
          },
        }),
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
// Shared preconditions — verified, not assumed.
// ───────────────────────────────────────────────────────────────────────────
describe('shared precondition · provision and seed the population (Test 1 — setup, not itself an assertion of the audience claim)', () => {
  it('precondition 1 · db:deploy → db:seed → db:bootstrap:access-control all exit 0, root is readable back', () => {
    const p = requireProvisioning();
    expect(p.deploy.exitCode).toBe(0);
    expect(p.seed.exitCode).toBe(0);
    expect(p.bootstrap.exitCode).toBe(0);
    expect(normalizeEmail(p.root.workEmail)).toBe(ROOT_WORK_EMAIL);
    expect(p.root.isActive).toBe(true);
  });

  it("s42d-ds-06 Test 1 · db:import:population and db:dev:seed-org both exit 0, matching s42d-ds-02's own shape", async () => {
    const p = requireProvisioning();
    expect(p.importRun.exitCode).toBe(0);
    expect(p.seedOrgRun.exitCode).toBe(0);

    // The lead's edge points straight at root — one hop.
    const leadEdges = await testApp.prisma.relationship.findMany({
      where: { userId: p.lead.id },
    });
    expect(leadEdges).toHaveLength(1);
    expect(leadEdges[0]).toMatchObject({
      type: 'direct',
      reportsToUserId: p.root.id,
    });

    // The ordinary member's edge points at the lead — two hops to root.
    const memberEdges = await testApp.prisma.relationship.findMany({
      where: { userId: p.member.id },
    });
    expect(memberEdges).toHaveLength(1);
    expect(memberEdges[0]).toMatchObject({
      type: 'direct',
      reportsToUserId: p.lead.id,
    });

    // The sole member of Solo — one hop, its own department's lead.
    const soloEdges = await testApp.prisma.relationship.findMany({
      where: { userId: p.solo.id },
    });
    expect(soloEdges).toHaveLength(1);
    expect(soloEdges[0]).toMatchObject({
      type: 'direct',
      reportsToUserId: p.root.id,
    });

    // Root itself never becomes a subject.
    expect(
      await testApp.prisma.relationship.count({ where: { userId: p.root.id } }),
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42d-ds-06 — root reads three sampled seeded members over HTTP.
// ───────────────────────────────────────────────────────────────────────────
describe('s42d-ds-06 · root resolves reporting write over every seeded member of a real, multi-department spine', () => {
  it('s42d-ds-06 Test 2 · root reads a department lead (one hop) → 200, canEdit true', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.lead.id },
    });

    const res = await getUser(p.lead.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), true);
  });

  it('s42d-ds-06 Test 3 · root reads an ordinary member (two hops, through their lead) → 200, canEdit true', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.member.id },
    });

    const res = await getUser(p.member.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), true);
  });

  it('s42d-ds-06 Test 4 · root reads the sole member of a single-person department → 200, canEdit true', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.solo.id },
    });

    const res = await getUser(p.solo.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), true);
  });

  // E4-C04a (test-design-epic-platform-4.md) — the dev-spine half of the
  // "root's own card" case. `db:dev:seed-org` writes edges FOR every seeded
  // member ONTO root; it writes no edge for root itself, so root's own
  // audience over its own card is `self`, not `reporting`, exactly as the
  // production-shaped s42a-op-04 Test 4 proves on a clean bootstrap.
  it('s42d-ds-06 Test 5 · root reads its own card → 200, canEdit false (self, not reporting)', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.root.id },
    });

    const res = await getUser(p.root.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AF-5 — the tie-break assertion (spec-4-2d Ask First AF-5; scenario doc
// s42d-ds-02's own "A user holds two concurrent DepartmentMembership rows"
// row). tieUser holds two current memberships (TieA from import, TieB from
// the real "plain add" POST above). The rule: the membership whose
// `departmentId` is LEXICOGRAPHICALLY SMALLEST decides which department's
// active-member list tieUser appears in for spine purposes. AF-5's own text
// says this choice cannot be observed beyond "which department's
// active-member list included this user" — asserted here exactly that way,
// determined dynamically from the two real (uuid7) department ids rather
// than assumed, since this suite does not control their generated values.
// ───────────────────────────────────────────────────────────────────────────
describe('AF-5 · the lexicographically-smallest-departmentId membership decides spine placement', () => {
  it("tieUser's spine edge is placed per whichever of TieA/TieB has the lexicographically smaller department id", async () => {
    const p = requireProvisioning();

    const winner = p.tieDeptA.id < p.tieDeptB.id ? 'TieA' : 'TieB';

    if (winner === 'TieA') {
      // TieA has only tieUser as an active member → tieUser is TieA's own
      // synthesized lead → one edge, straight to root. TieB, with tieUser
      // excluded, has only tieColleague, who becomes TieB's own lead.
      const tieUserEdges = await testApp.prisma.relationship.findMany({
        where: { userId: p.tieUser.id },
      });
      expect(tieUserEdges).toHaveLength(1);
      expect(tieUserEdges[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: p.root.id,
      });

      const colleagueEdges = await testApp.prisma.relationship.findMany({
        where: { userId: p.tieColleague.id },
      });
      expect(colleagueEdges).toHaveLength(1);
      expect(colleagueEdges[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: p.root.id,
      });
    } else {
      // TieB wins: its active-member list is {tieColleague, tieUser}.
      // tieColleague was imported first (smaller User.id) → tieColleague is
      // TieB's synthesized lead; tieUser is TieB's ordinary member. TieA,
      // with tieUser excluded, has zero active members and is skipped
      // entirely — no edge exists for tieUser via TieA.
      const colleagueEdges = await testApp.prisma.relationship.findMany({
        where: { userId: p.tieColleague.id },
      });
      expect(colleagueEdges).toHaveLength(1);
      expect(colleagueEdges[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: p.root.id,
      });

      const tieUserEdges = await testApp.prisma.relationship.findMany({
        where: { userId: p.tieUser.id },
      });
      expect(tieUserEdges).toHaveLength(1);
      expect(tieUserEdges[0]).toMatchObject({
        type: 'direct',
        reportsToUserId: p.tieColleague.id,
      });
    }

    // Either way, tieUser holds EXACTLY ONE direct edge overall — the
    // schema's own `relationships_one_direct_per_user` constraint, and the
    // concrete proof that the tie-break picked exactly one department, not
    // both.
    expect(
      await testApp.prisma.relationship.count({
        where: { userId: p.tieUser.id, type: 'direct' },
      }),
    ).toBe(1);
  });
});
