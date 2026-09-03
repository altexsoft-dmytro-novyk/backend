import request from 'supertest';
import {
  type ImportSummary,
  type ScriptRun,
  type SeedCsvRow,
  type TestApp,
  IMPORT_SCRIPT,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  cleanupImportedRows,
  normalizeEmail,
  relationExists,
  runScript,
  toDeliveredCsv,
} from './fixtures';

/**
 * Epic 1 — Story 1.1 (Import Seeded Population) · AD-1 Stage 2 · committed RED.
 *
 * Real-consumer HTTP E2E for `POST /users/import`:
 *   real HTTP → Nest router → SessionGuard → AccessControlGuard → real
 *   AccessControlFacade → real Prisma → migrated PostgreSQL. NO provider
 *   overrides (AD-3). Multipart upload via supertest `.attach('file', …)`.
 *   The happy-path operator is a real HR-Admin `User` + the real FR grant
 *   chain for `user-management:create` (mirrors
 *   access-control-adoption/no-target-permission.e2e-spec.ts Test 1).
 *
 * One `it()` (or `describe`) per approved Stage-1 scenario, id in the title:
 *   docs/test-cases/user-management/seed/um-seed-01 … um-seed-13 (+ README).
 *
 * ── WHY THIS SUITE IS RED (state today, 2026-09-02) ────────────────────────
 * Stage 3 has NOT shipped. Concretely:
 *   • `POST /users/import` is not a route — `users.controller.ts` declares
 *     `@Post()` (`/users` create) only, no `@Post('import')`. Every request
 *     below resolves to **404** (route absent), so `res.status === 200` /
 *     `403` / `401` and every summary-body assertion fails.
 *   • The Story 1.1 schema does not exist: no `department`,
 *     `department_membership`, `employment_status`, or `user_events` relation
 *     (`schema.prisma` has only User / Relationship / Project / Policies /
 *     Permissions / …). Every raw read of those tables throws
 *     "relation does not exist" → the test errors red.
 *   • There is no import writer / normalization / idempotent-upsert code.
 *   • `um-seed-12` invokes `npm run <IMPORT_SCRIPT>` ('db:import:population',
 *     an assumed name — decision 20) which is a "Missing script" → non-zero
 *     exit.
 * Exceptions that are red for a *different* reason (noted per test):
 *   • `um-seed-02` — `POST /users` IS still wired (AD-21 cutover removes it in
 *     the same change that adds the import): returns 201 for the seeded
 *     operator, 403 for an unrelated session. Target is 404/405, identical
 *     across sessions.
 *   • `um-seed-11` Test 3 — the interim session resolver returns a session for
 *     ANY `Bearer <token:<uuid>>`, so an unresolved-principal token reaches the
 *     capability gate and gets 403, not 401. Stays red past Stage 3 until Epic
 *     2 ships real session issuance. Flagged; kept faithful to the scenario.
 *
 * Assumed contract (settled in-scenario, "confirm at approval" — seed README
 * "Decisions made in-scenario"): endpoint path `POST /users/import`; new-table
 * @@map names `department` / `department_membership` / `employment_status` /
 * `user_events` (the scenario docs' "database state" sections); summary shape
 * `{ created, updated, departmentsCreated, skipped, errors[] }`.
 *
 * DEC-UM-010: one worker; every fixture row's email carries the run namespace
 * (`fx.runId`); each test deletes only what it created (imported rows first,
 * then `fx.cleanup()`), wrapped so one failure never skips the rest.
 */

// ───────────────────────────────────────────────────────────────────────────
// shared harness
// ───────────────────────────────────────────────────────────────────────────

let testApp: TestApp;
let fx: RunFixtures;

beforeAll(async () => {
  testApp = await bootstrapTestApp();
});

beforeEach(() => {
  fx = new RunFixtures(testApp.prisma);
});

afterEach(async () => {
  await cleanupImportedRows(testApp.prisma, fx.runId);
  await fx.cleanup();
});

afterAll(async () => {
  await testApp.app.close();
  await testApp.moduleFixture.close();
});

/** A real HR-Admin `User` holding the live FR grant chain for
 *  `user-management:create` — the sole authorized import operator (ACM-1). */
async function seedImportOperator(): Promise<{ id: string }> {
  const root = await fx.user('seed-root', { position: 'HR Admin' });
  await fx.grantFunctionalRole(root.id); // default keys include user-management:create
  return root;
}

const server = () => testApp.app.getHttpServer();

/** Multipart `POST /users/import` with one `file` part (a CSV string). */
function importCsv(
  auth: string | null,
  csv: string,
  filename = 'population.csv',
) {
  const req = request(server()).post('/users/import');
  if (auth !== null) req.set('authorization', auth);
  return req.attach('file', Buffer.from(csv, 'utf8'), filename);
}

/** Run-namespaced pseudonymised address whose local part carries `fx.runId`. */
const mail = (local: string) => `${fx.runId}-${local}@x.example`;

/** The shared `seed-basic.csv` composition (seed README "Fixture convention"),
 *  every email / department id+name carrying the run namespace. */
function seedBasicRows(): { rows: SeedCsvRow[]; emails: string[] } {
  const dep = (n: string) => `${fx.runId}-${n}`;
  const rows: SeedCsvRow[] = [
    row(mail('ada'), {
      Birthday: '1990-12-10',
      DepartmentId: dep('1'),
      DepartmentName: dep('JS'),
    }),
    row(mail('grace'), {
      Birthday: 'NULL',
      DepartmentId: dep('1'),
      DepartmentName: dep('JS'),
    }),
    row(mail('alan'), {
      Birthday: '1988-06-23',
      DepartmentId: dep('2'),
      DepartmentName: dep('QA'),
      IsDismissed: '1',
      DismissedDate: '2026-07-31',
    }),
    row(` ${fx.runId}-Katherine@X.Example `, {
      Birthday: '1979-03-02',
      DepartmentId: dep('2'),
      DepartmentName: dep('QA'),
    }),
    row(mail('linus'), {
      Birthday: 'NULL',
      DepartmentId: dep('3'),
      DepartmentName: dep('Infra'),
    }),
  ];
  const emails = rows.map((r) => normalizeEmail(r.Email ?? ''));
  return { rows, emails };
}

/** A well-formed CSV data row with sane defaults for the columns a test
 *  does not care about. */
function row(email: string, overrides: SeedCsvRow = {}): SeedCsvRow {
  return {
    FirstName: 'Test',
    LastName: 'Person',
    Email: email,
    Birthday: 'NULL',
    PositionId: '2',
    PositionName: 'Developer',
    RegistrationDate: '2024-01-15',
    DepartmentId: `${fx.runId}-1`,
    DepartmentName: `${fx.runId}-JS`,
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

/** Count `users` rows whose stored `workEmail` normalizes to `email`. */
async function userCount(email: string): Promise<number> {
  const r = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM users WHERE lower(trim("workEmail")) = $1`,
    normalizeEmail(email),
  );
  return Number(r[0].n);
}

async function findUser(email: string) {
  return testApp.prisma.user.findFirst({
    where: {
      workEmail: { equals: normalizeEmail(email), mode: 'insensitive' },
    },
  });
}

/** Raw rows for a Story-1.1 table filtered to this run's imported users. */
async function importedRows<T = Record<string, unknown>>(
  table: 'department_membership' | 'employment_status' | 'user_events',
): Promise<T[]> {
  return testApp.prisma.$queryRawUnsafe<T[]>(
    `SELECT t.* FROM ${table} t
       JOIN users u ON u.id = t."userId"
      WHERE u."workEmail" ILIKE $1`,
    `%${fx.runId}%`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// um-seed-01 — happy path: one canonical User per CSV row + derived rows
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-01 · population import → one canonical User per CSV row', () => {
  it('um-seed-01 · 200 + summary {created:5, departmentsCreated:3}; 5 mapped User rows, derived rows [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const { rows, emails } = seedBasicRows();

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));

    expect(res.status).toBe(200);
    expect(res.body as ImportSummary).toEqual({
      created: 5,
      updated: 0,
      departmentsCreated: 3,
      skipped: 0,
      errors: [],
    });

    // one User per data row, mapped S1 fields, normalized workEmail
    for (const email of emails) {
      expect(await userCount(email)).toBe(1);
    }
    const ada = await findUser(mail('ada'));
    expect(ada).not.toBeNull();
    expect(ada?.firstName).toBe('Test');
    expect(ada?.lastName).toBe('Person');
    expect(ada?.position).toBe('Developer'); // PositionName -> position
    expect(ada?.country).toBe('Ukraine'); // CountryName -> country
    expect(ada?.companyJoinDate.toISOString().slice(0, 10)).toBe('2024-01-15');
    expect(ada?.isActive).toBe(true);
    expect(ada?.customFields).toEqual({}); // DEC-UM-003
    expect(ada?.createdBy).toBe(root.id); // import runs as the root operator
    // null-source fields
    expect(ada?.workPhone).toBeNull();
    expect(ada?.city).toBeNull();
    expect(ada?.photo).toBeNull();
    expect(ada?.ttId).toBeNull();
    // Katherine row stored trim+lowercase (DEC-UM-007)
    const kat = await findUser(`${fx.runId}-katherine@x.example`);
    expect(kat?.workEmail).toBe(`${fx.runId}-katherine@x.example`);

    // exactly one DepartmentMembership + one EmploymentStatus + one
    // joined_company UserEvents per new user
    expect(await relationExists(testApp.prisma, 'department')).toBe(true);
    const memberships = await importedRows('department_membership');
    expect(memberships).toHaveLength(5);
    const statuses = await importedRows('employment_status');
    expect(statuses).toHaveLength(5);
    const events = await importedRows<{ type: string; source: string }>(
      'user_events',
    );
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.type === 'joined_company')).toBe(true);
    expect(events.every((e) => e.source === 'system')).toBe(true);

    // 3 Department rows for the 3 distinct (externalId, name) pairs
    const deps = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM department WHERE name ILIKE $1`,
      `%${fx.runId}%`,
    );
    expect(Number(deps[0].n)).toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-02 — there is no POST /users single-create path
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-02 · POST /users is absent or permanently rejected', () => {
  const createBody = (email: string) => ({
    firstName: 'Nina',
    lastName: 'Volkova',
    position: 'QA Engineer',
    country: 'Poland',
    city: 'Krakow',
    workEmail: email,
    companyJoinDate: '2026-09-01',
  });

  const postUsers = (auth: string, email: string) =>
    request(server())
      .post('/users')
      .set('authorization', auth)
      .send(createBody(email));

  it('um-seed-02 Test 1 · HR-Admin session POST /users → 404/405, no row [RED: route wired, returns 201]', async () => {
    const root = await seedImportOperator();
    const email = mail('seed02-hradmin-nina');

    const res = await postUsers(bearer(root.id), email);

    expect([404, 405]).toContain(res.status); // NOT 403 — absence is not denial
    expect(await userCount(email)).toBe(0);
  });

  it('um-seed-02 Test 2 · unrelated session POST /users → identical status to Test 1 [RED: 403 today]', async () => {
    const root = await seedImportOperator();
    const colin = await fx.user('seed02-colin', { position: 'Engineer' });

    const hrAdminRes = await postUsers(
      bearer(root.id),
      mail('seed02-cmp-nina'),
    );
    const unrelatedRes = await postUsers(
      bearer(colin.id),
      mail('seed02-unrelated-nina'),
    );

    expect([404, 405]).toContain(unrelatedRes.status);
    expect(unrelatedRes.status).toBe(hrAdminRes.status);
    expect(await userCount(mail('seed02-unrelated-nina'))).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-03 — a CSV row for the root person updates the ACM-0 root in place
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-03 · root-row reuse on import (DEC-UM-009)', () => {
  it('um-seed-03 · a row normalizing to the operator email is updated in place — same id/createdAt, counts as updated, hr-admin attachment untouched, no joined_company for root [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const before = await testApp.prisma.user.findUnique({
      where: { id: root.id },
    });
    expect(before).not.toBeNull();

    // sole data row's Email normalizes to the operator's own (root) workEmail,
    // with a whitespace/upper-case variant to prove canonical-at-write, and a
    // different PositionName / RegistrationDate so the in-place update shows.
    const rootRow = row(` ${before!.workEmail.toUpperCase()} `, {
      FirstName: 'Root',
      LastName: 'Operator',
      PositionName: 'Principal Engineer',
      RegistrationDate: '2020-02-02',
      DepartmentId: `${fx.runId}-9`,
      DepartmentName: `${fx.runId}-Ops`,
    });

    const res = await importCsv(bearer(root.id), toDeliveredCsv([rootRow]));

    expect(res.status).toBe(200);
    const summary = res.body as ImportSummary;
    expect(summary.updated).toBe(1);
    expect(summary.created).toBe(0);
    expect(summary.errors).toEqual([]);

    // exactly one row for that normalized email; id / createdAt unchanged
    expect(await userCount(before!.workEmail)).toBe(1);
    const after = await testApp.prisma.user.findUnique({
      where: { id: root.id },
    });
    expect(after?.id).toBe(before!.id);
    expect(after?.createdAt.toISOString()).toBe(
      before!.createdAt.toISOString(),
    );
    expect(after?.createdBy).toBe(before!.createdBy);
    expect(after?.position).toBe('Principal Engineer'); // import-owned column refreshed

    // still exactly one hr-admin FR attachment, still this root id
    const attach = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n
         FROM "UserPolicies" up JOIN "Policies" p ON p.id = up."policyId"
        WHERE p.type = 'FR' AND up."userId" = $1`,
      root.id,
    );
    expect(Number(attach[0].n)).toBe(1);

    // no joined_company event for the root person (updated, not inserted)
    if (await relationExists(testApp.prisma, 'user_events')) {
      const ev = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM user_events WHERE "userId" = $1 AND type = 'joined_company'`,
        root.id,
      );
      expect(Number(ev[0].n)).toBe(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-04 — Department create-on-import: identity is the (externalId, name) pair
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-04 · Department create-on-import', () => {
  it('um-seed-04 · new pair → new Department; repeat externalId+same name → reused; repeat externalId+different name → second row; one membership per user; departmentsCreated counts new only [RED: no department table / POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const ext = (n: string) => `${fx.runId}-${n}`;
    const rows: SeedCsvRow[] = [
      row(mail('d-a'), {
        DepartmentId: ext('10'),
        DepartmentName: `${fx.runId}-Platform`,
        RegistrationDate: '2022-03-01',
      }),
      row(mail('d-b'), {
        DepartmentId: ext('10'),
        DepartmentName: `${fx.runId}-Platform Engineering`, // divergent name → second row
        RegistrationDate: '2022-04-01',
      }),
      row(mail('d-c'), {
        DepartmentId: ext('20'),
        DepartmentName: `${fx.runId}-Design`,
      }),
      row(mail('d-d'), {
        DepartmentId: ext('30'),
        DepartmentName: `${fx.runId}-Data`,
      }),
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));

    expect(res.status).toBe(200);
    expect((res.body as ImportSummary).departmentsCreated).toBe(4);
    expect((res.body as ImportSummary).created).toBe(4);

    const deps = await testApp.prisma.$queryRawUnsafe<
      Array<{ externalId: string; name: string; parentId: string | null }>
    >(
      `SELECT "externalId", name, "parentId" FROM department WHERE name ILIKE $1 ORDER BY 1, 2`,
      `%${fx.runId}%`,
    );
    expect(deps).toHaveLength(4);
    expect(deps.every((d) => d.parentId === null)).toBe(true);
    const tenCount = deps.filter((d) => d.externalId === ext('10')).length;
    expect(tenCount).toBe(2); // identity is the pair, not the id alone

    // one current membership per imported user (CSV carries one DepartmentId/row)
    const memberships = await importedRows<{ validTo: string | null }>(
      'department_membership',
    );
    expect(memberships).toHaveLength(4);
    expect(memberships.every((m) => m.validTo === null)).toBe(true);

    // no Unit-Manager policy, no department_change event
    const arPolicies = await testApp.prisma.$queryRawUnsafe<
      Array<{ n: bigint }>
    >(
      `SELECT count(*)::bigint AS n FROM "Policies" WHERE "targetType" = 'department'`,
    );
    expect(Number(arPolicies[0].n)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-05 — IsDismissed + dates → one EmploymentStatus row; isActive untouched
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-05 · EmploymentStatus mapping', () => {
  it('um-seed-05 · active → {active, validFrom:RegistrationDate}; dismissed → {dismissed, validFrom:DismissedDate, sourceDepartureId:null, departureReason:null}; User.isActive true on both [RED: no employment_status table / POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const rows: SeedCsvRow[] = [
      row(mail('working'), {
        RegistrationDate: '2024-02-01',
        IsDismissed: '0',
      }),
      row(mail('left'), {
        RegistrationDate: '2021-05-10',
        IsDismissed: '1',
        DismissedDate: '2026-07-31',
      }),
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));
    expect(res.status).toBe(200);
    expect((res.body as ImportSummary).created).toBe(2);

    const statuses = await importedRows<{
      status: string;
      validFrom: string;
      validTo: string | null;
      departureReason: string | null;
      sourceDepartureId: string | null;
      userId: string;
    }>('employment_status');
    expect(statuses).toHaveLength(2);

    const working = await findUser(mail('working'));
    const left = await findUser(mail('left'));
    const activeRow = statuses.find((s) => s.userId === working?.id);
    const dismissedRow = statuses.find((s) => s.userId === left?.id);

    expect(activeRow?.status).toBe('active');
    expect(new Date(activeRow!.validFrom).toISOString().slice(0, 10)).toBe(
      '2024-02-01',
    );
    expect(dismissedRow?.status).toBe('dismissed');
    expect(new Date(dismissedRow!.validFrom).toISOString().slice(0, 10)).toBe(
      '2026-07-31',
    );
    expect(dismissedRow?.validTo).toBeNull();
    expect(dismissedRow?.sourceDepartureId).toBeNull();
    expect(dismissedRow?.departureReason).toBeNull();

    // isActive is the account-retention flag — true even for the dismissed row
    expect(working?.isActive).toBe(true);
    expect(left?.isActive).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-06 — Birthday split day/month, year dropped; NULL → both null
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-06 · Birthday split', () => {
  it('um-seed-06 · dated Birthday → birthDay+birthMonth (year dropped); NULL → both null; never a half-pair [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const rows: SeedCsvRow[] = [
      row(mail('dated'), { Birthday: '1990-12-10' }),
      row(mail('unknown'), { Birthday: 'NULL' }),
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));
    expect(res.status).toBe(200);

    const dated = await findUser(mail('dated'));
    expect(dated?.birthDay).toBe(10);
    expect(dated?.birthMonth).toBe(12);

    const unknown = await findUser(mail('unknown'));
    expect(unknown?.birthDay).toBeNull();
    expect(unknown?.birthMonth).toBeNull();

    // no imported row anywhere in this run holds the year 1990
    const yearLeak = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM users
        WHERE "workEmail" ILIKE $1 AND "customFields"::text LIKE '%1990%'`,
      `%${fx.runId}%`,
    );
    expect(Number(yearLeak[0].n)).toBe(0);

    // no half-pair among imported rows
    const halfPair = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM users
        WHERE "workEmail" ILIKE $1 AND (("birthDay" IS NULL) <> ("birthMonth" IS NULL))`,
      `%${fx.runId}%`,
    );
    expect(Number(halfPair[0].n)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-07 — fields with no CSV source → null; createdBy = root; customFields {}
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-07 · null-source fields', () => {
  it('um-seed-07 · ttId/city/workPhone/photo null on every row; multiple null ttId coexist; createdBy = root id; customFields {}; unmapped CSV columns not stored [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const rows: SeedCsvRow[] = [
      row(mail('n1')),
      row(mail('n2')),
      row(mail('n3')),
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));
    expect(res.status).toBe(200);
    expect((res.body as ImportSummary).skipped).toBe(0);

    const imported = await testApp.prisma.user.findMany({
      where: { workEmail: { contains: fx.runId } },
    });
    const seeded = imported.filter((u) => u.id !== root.id);
    expect(seeded).toHaveLength(3);
    for (const u of seeded) {
      expect(u.ttId).toBeNull();
      expect(u.city).toBeNull();
      expect(u.workPhone).toBeNull();
      expect(u.photo).toBeNull();
      expect(u.customFields).toEqual({});
      expect(u.createdBy).toBe(root.id);
    }

    // unmapped CSV columns (TimeZone / EmployeeType / PositionId / Country*)
    // are not stored anywhere on the row
    const leak = await testApp.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM users
        WHERE "workEmail" ILIKE $1
          AND ("customFields"::text LIKE '%Europe/Kyiv%'
               OR "customFields"::text LIKE '%Employee%')`,
      `%${fx.runId}%`,
    );
    expect(Number(leak[0].n)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-08 — re-import is idempotent; owned-fields-only refresh
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-08 · idempotent re-import', () => {
  it('um-seed-08 · second import of the same file → {created:0, updated:5, departmentsCreated:0}; no dup rows/depts/memberships/events; out-of-band photo/ttId/customFields survive [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const { rows, emails } = seedBasicRows();
    const csv = toDeliveredCsv(rows);

    const first = await importCsv(bearer(root.id), csv);
    expect(first.status).toBe(200);
    expect((first.body as ImportSummary).created).toBe(5);

    // out-of-band edit on one imported row (a later authorized edit / TT sync)
    const ada = await findUser(mail('ada'));
    expect(ada).not.toBeNull();
    await testApp.prisma.user.update({
      where: { id: ada!.id },
      data: {
        photo: 'https://photos.example/oob.jpg',
        ttId: `${fx.runId}-tt-oob`,
        customFields: { note: 'x' },
      },
    });

    const second = await importCsv(bearer(root.id), csv);
    expect(second.status).toBe(200);
    expect(second.body as ImportSummary).toEqual({
      created: 0,
      updated: 5,
      departmentsCreated: 0,
      skipped: 0,
      errors: [],
    });

    // no duplicates: still one row per normalized email
    for (const email of emails) {
      expect(await userCount(email)).toBe(1);
    }
    expect(await importedRows('department_membership')).toHaveLength(5);
    expect(await importedRows('employment_status')).toHaveLength(5);
    const events = await importedRows<{ type: string }>('user_events');
    expect(events.filter((e) => e.type === 'joined_company')).toHaveLength(5);

    // out-of-band fields untouched
    const adaAfter = await findUser(mail('ada'));
    expect(adaAfter?.photo).toBe('https://photos.example/oob.jpg');
    expect(adaAfter?.ttId).toBe(`${fx.runId}-tt-oob`);
    expect(adaAfter?.customFields).toEqual({ note: 'x' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-09 — file-level 400 nothing written; row-level 200 per-row skip
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-09 · malformed rows skipped / file-level 400', () => {
  it('um-seed-09 Test 1 · mixed file → 200; good rows commit, bad rows per-row skipped with errors[] (in-file dup email → first kept, later skipped "email already exists") [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const rows: SeedCsvRow[] = [
      row(mail('ok1')), // line 1 — imports
      row('', { FirstName: 'No', LastName: 'Email' }), // line 2 — missing required Email
      row(mail('bad-bday'), { Birthday: '1990-13-40' }), // line 3 — unparseable Birthday
      row(mail('dup')), // line 4 — first occurrence, imports
      row(` ${fx.runId}-DUP@x.example `), // line 5 — normalizes to line 4 → skipped
      row(mail('ok2')), // line 6 — imports
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));

    expect(res.status).toBe(200);
    const summary = res.body as ImportSummary;
    expect(summary.created).toBe(3);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.errors).toHaveLength(3);

    const dupErr = summary.errors.find((e) => e.line === 5);
    expect(dupErr?.reason).toBe('email already exists');
    expect(dupErr?.email).toBe(normalizeEmail(mail('dup')));

    // good rows committed, skipped rows wrote nothing
    expect(await userCount(mail('ok1'))).toBe(1);
    expect(await userCount(mail('dup'))).toBe(1);
    expect(await userCount(mail('ok2'))).toBe(1);
    expect(await userCount(mail('bad-bday'))).toBe(0);
  });

  it('um-seed-09 Test 2 · re-import the corrected file → previously-skipped rows now created, good rows updated, skipped:0 [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const good: SeedCsvRow[] = [
      row(mail('ok1')),
      row(mail('dup')),
      row(mail('ok2')),
    ];
    const first = await importCsv(bearer(root.id), toDeliveredCsv(good));
    expect(first.status).toBe(200);

    const corrected: SeedCsvRow[] = [
      row(mail('ok1')),
      row(mail('was-missing')), // line 2 now has an Email
      row(mail('bad-bday'), { Birthday: '1990-03-04' }), // line 3 fixed
      row(mail('dup')),
      row(mail('ok2')),
    ];
    const second = await importCsv(bearer(root.id), toDeliveredCsv(corrected));
    expect(second.status).toBe(200);
    const summary = second.body as ImportSummary;
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.updated).toBe(3); // ok1, dup, ok2
    expect(summary.created).toBe(2); // was-missing, bad-bday
  });

  it('um-seed-09 Test 3 · file-level failure → 400, nothing written', async () => {
    const root = await seedImportOperator();

    // (a) no file part — a JSON body instead
    const noFile = await request(server())
      .post('/users/import')
      .set('authorization', bearer(root.id))
      .send({ path: 'docs/Accounts_template.csv' });
    expect(noFile.status).toBe(400);

    // (b) header mismatch — a CSV whose header is not the delivered column set
    const badHeader = await importCsv(
      bearer(root.id),
      'a;b;c\n1;2;3\n',
      'bad-header.csv',
    );
    expect(badHeader.status).toBe(400);

    // (c) not a CSV — a binary part with the wrong content-type
    const notCsv = await request(server())
      .post('/users/import')
      .set('authorization', bearer(root.id))
      .attach('file', Buffer.from([0x00, 0x01, 0x02, 0x03]), {
        filename: 'x.bin',
        contentType: 'application/octet-stream',
      });
    expect(notCsv.status).toBe(400);

    // nothing written for any sub-case
    const written = await testApp.prisma.user.count({
      where: { workEmail: { contains: fx.runId } },
    });
    expect(written).toBe(1); // only the seeded operator row
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-10 — the import is HR-Admin-only (user-management:create) → 403
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-10 · import without capability → 403', () => {
  it('um-seed-10 Test 1 · Ida (unrelated FR permission, DEC-UM-002) → 403, nothing written [RED: POST /users/import is 404]', async () => {
    const ida = await fx.user('seed10-ida', { position: 'Engineer' });
    await fx.grantFunctionalRole(ida.id, [
      `seed10:create-form-campaigns-${fx.runId}`,
    ]);
    const { rows } = seedBasicRows();

    const res = await importCsv(bearer(ida.id), toDeliveredCsv(rows));

    expect(res.status).toBe(403);
    expect(
      await testApp.prisma.user.count({
        where: { workEmail: { contains: fx.runId } },
      }),
    ).toBe(1); // only Ida herself
  });

  it('um-seed-10 Test 2 · unrelated active session, no FR policy → 403, identical body shape [RED: POST /users/import is 404]', async () => {
    const colin = await fx.user('seed10-colin', { position: 'Engineer' });
    const { rows } = seedBasicRows();

    const res = await importCsv(bearer(colin.id), toDeliveredCsv(rows));

    expect(res.status).toBe(403);
    expect(
      await testApp.prisma.user.count({
        where: { workEmail: { contains: fx.runId } },
      }),
    ).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-11 — import unauthenticated → 401 before the capability gate
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-11 · import unauthenticated → 401', () => {
  it('um-seed-11 Test 1 · no Authorization header → 401, nothing written [RED: POST /users/import is 404]', async () => {
    const { rows } = seedBasicRows();
    const res = await importCsv(null, toDeliveredCsv(rows));
    expect(res.status).toBe(401);
    expect(
      await testApp.prisma.user.count({
        where: { workEmail: { contains: fx.runId } },
      }),
    ).toBe(0);
  });

  it('um-seed-11 Test 2 · malformed bearer token → 401 [RED: POST /users/import is 404]', async () => {
    const { rows } = seedBasicRows();
    const res = await importCsv(
      'Bearer not-a-real-token',
      toDeliveredCsv(rows),
    );
    expect(res.status).toBe(401);
  });

  it('um-seed-11 Test 3 · valid-shape token, unresolved principal → 401 (session never resolves; Epic 2 real resolver)', async () => {
    const { rows } = seedBasicRows();
    const res = await importCsv(
      bearer(`${fx.runId}-nonexistent`),
      toDeliveredCsv(rows),
    );
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-12 — the deploy-script entrypoint + HTTP endpoint is upload-only
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-12 · deploy-script entrypoint', () => {
  it(`um-seed-12 Test 1/2 · the population-import deploy script runs in order and is re-runnable [RED: \`npm run ${IMPORT_SCRIPT}\` is a missing script — the exact name is a stage-3 choice, decision 20]`, async () => {
    const importRun: ScriptRun = await runScript(IMPORT_SCRIPT);
    expect(importRun.exitCode).toBe(0);

    // second run is idempotent (no new rows) — only meaningful once the script
    // exists; asserted here so it goes green with Stage 3.
    const rerun: ScriptRun = await runScript(IMPORT_SCRIPT);
    expect(rerun.exitCode).toBe(0);
  });

  it('um-seed-12 Test 3 · HTTP endpoint is upload-only — a JSON body naming a path (no file part) → 400, nothing written [RED: POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const res = await request(server())
      .post('/users/import')
      .set('authorization', bearer(root.id))
      .set('content-type', 'application/json')
      .send({ path: 'docs/Accounts_template.csv' });

    expect(res.status).toBe(400);
    expect(
      await testApp.prisma.user.count({
        where: { workEmail: { contains: fx.runId } },
      }),
    ).toBe(1); // only the operator row
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-13 — one joined_company UserEvents per new User, in the row transaction
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-13 · joined_company event in the row transaction', () => {
  it('um-seed-13 Test 1 · one joined_company {source:system, eventDate:companyJoinDate, createdBy:root, deletedAt:null} per new User; no other event type [RED: no user_events table / POST /users/import is 404]', async () => {
    const root = await seedImportOperator();
    const rows: SeedCsvRow[] = [
      row(mail('t1'), { RegistrationDate: '2023-01-02' }),
      row(mail('t2'), { RegistrationDate: '2023-06-07' }),
      row(mail('t3'), { RegistrationDate: '2024-11-12' }),
    ];

    const res = await importCsv(bearer(root.id), toDeliveredCsv(rows));
    expect(res.status).toBe(200);
    expect((res.body as ImportSummary).created).toBe(3);

    const events = await importedRows<{
      type: string;
      source: string;
      eventDate: string;
      createdBy: string;
      deletedAt: string | null;
      userId: string;
    }>('user_events');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'joined_company')).toBe(true);
    expect(events.every((e) => e.source === 'system')).toBe(true);
    expect(events.every((e) => e.createdBy === root.id)).toBe(true);
    expect(events.every((e) => e.deletedAt === null)).toBe(true);

    const t1 = await findUser(mail('t1'));
    const t1Event = events.find((e) => e.userId === t1?.id);
    expect(new Date(t1Event!.eventDate).toISOString().slice(0, 10)).toBe(
      '2023-01-02',
    );

    // only joined_company written by this import
    const distinctTypes = new Set(events.map((e) => e.type));
    expect([...distinctTypes]).toEqual(['joined_company']);
  });

  // Test 2 (atomicity: force the joined_company insert to fail for one row and
  // assert that row's User / DepartmentMembership / EmploymentStatus are also
  // absent) needs a fault-injection hook on the import writer. There is no such
  // hook, and AD-3 forbids provider overrides in this real-consumer suite, so
  // there is no in-suite seam to force a mid-row-transaction failure over real
  // HTTP. Left as a todo for a stage-2 fault-injection mechanism / a writer
  // unit test.
  it.todo(
    'um-seed-13 Test 2 · joined_company insert fails for one row → that row fully rolled back, others import (needs a fault-injection seam; AD-3 forbids provider overrides here)',
  );
});
