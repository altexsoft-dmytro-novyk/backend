import request from 'supertest';
import {
  IMPORT_SCRIPT,
  POPULATION_CSV_PATH,
  RunFixtures,
  type ScriptRun,
  type TestApp,
  bearer,
  bootstrapTestApp,
  isCsvNull,
  normalizeEmail,
  rawPrisma,
  readSemicolonCsv,
  relationExists,
  runScript,
  writeTempPopulationCsv,
} from './fixtures';

/**
 * Epic 1 — Story 1.1 (Import Seeded Population) · AD-1 Stage 2, committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/seed/
 *     um-seed-01-import-success.md              -> DB-state, no HTTP
 *     um-seed-02-no-post-users-create-path.md   -> the one HTTP assertion
 *     um-seed-03-bootstrap-hr-admin-and-root-id-reuse.md -> DB-state, no HTTP
 *
 * ── RED / GREEN classification (see OUTPUT section of the dispatch) ──────────
 *
 *  um-seed-01  RED — red-because-not-implemented. There is no population import
 *              entrypoint at all: `npm run <IMPORT_SCRIPT>` exits non-zero
 *              ("Missing script"), so `importRun.exitCode === 0` fails and every
 *              row/field/normalization assertion below it fails (no imported
 *              row exists). The `joined_company` assertion is ADDITIONALLY red
 *              on a missing model — there is no `user_events` table / `UserEvents`
 *              Prisma model (schema.prisma has User / Relationship / Project /
 *              Policy… and no event table; E2E audit §0 confirms).
 *
 *  um-seed-02  RED — red-because-wrong-behaviour. `POST /users` is still wired
 *              (`users.controller.ts:72`, AD-21 cutover removes it later): today
 *              it returns 201 for `Bearer <token:Root>` and 403 for an unrelated
 *              session — neither is the v1.5 target (404/405, and identical
 *              across sessions). This is the deliberate exception to "um-seed-*
 *              is DB-state not HTTP".
 *
 *  um-seed-03  MIXED. The ACM-0 / ACM-1 half is GREEN characterization
 *              (`db:seed` + `db:bootstrap:access-control` already exist and
 *              produce exactly one `hr-admin` FR attachment on the normalized
 *              root row). The import half is RED-because-not-implemented — the
 *              root-id-reuse (DEC-UM-009) assertions are gated on the same
 *              missing importer as um-seed-01.
 *
 * AD-3: real Prisma against migrated PostgreSQL; the deploy-order scripts are
 * executed as their real production entrypoints, never reproduced inline.
 * DEC-UM-010: one worker, run-namespaced data, wrapped scoped teardown.
 */

const prisma = rawPrisma();

afterAll(async () => {
  await prisma.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-01 — population import creates one canonical User row per CSV row
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-01 · population import → one canonical User per CSV row (e2e, DB-state)', () => {
  const { rows: csvRows } = readSemicolonCsv(POPULATION_CSV_PATH);
  const csvEmails = csvRows.map((r) => normalizeEmail(r.Email));
  let importRun: ScriptRun;

  beforeAll(async () => {
    // Precondition = "the population import runs to completion". Its production
    // entrypoint is invoked here (see fixtures.IMPORT_SCRIPT); it does not exist
    // yet, so this run fails and the suite is committed-red on it.
    importRun = await runScript(IMPORT_SCRIPT);
  });

  afterAll(async () => {
    const teardown: Array<() => Promise<unknown>> = [
      async () => {
        if (await relationExists(prisma, 'user_events')) {
          await prisma.$executeRawUnsafe(
            `DELETE FROM "user_events" WHERE "userId" IN (SELECT id FROM users WHERE lower(trim("workEmail")) = ANY($1::text[]))`,
            csvEmails,
          );
        }
      },
      () =>
        prisma.relationship.deleteMany({
          where: { user: { workEmail: { in: csvRows.map((r) => r.Email) } } },
        }),
      () =>
        prisma.user.deleteMany({
          where: {
            OR: csvEmails.map((e) => ({
              workEmail: { equals: e, mode: 'insensitive' as const },
            })),
          },
        }),
    ];
    for (const step of teardown) {
      try {
        await step();
      } catch (error) {
        console.warn('[um-seed-01] teardown step failed', error);
      }
    }
  });

  it(
    'um-seed-01 · the import entrypoint runs to completion [RED: no importer — `npm run ' +
      IMPORT_SCRIPT +
      '` is missing]',
    () => {
      expect(importRun.exitCode).toBe(0);
    },
  );

  it('um-seed-01 · exactly one User row per CSV data row (+ the pre-existing ACM-0 root) [RED: importer missing]', async () => {
    for (const csv of csvRows) {
      const row = await prisma.user.findFirst({
        where: { workEmail: { equals: csv.Email, mode: 'insensitive' } },
      });
      expect(row).not.toBeNull();
    }
    // No duplicate imported rows.
    const dupes = await prisma.$queryRawUnsafe<Array<{ workemail: string }>>(
      `SELECT lower(trim("workEmail")) AS workemail, count(*) AS n
         FROM users WHERE lower(trim("workEmail")) = ANY($1::text[])
        GROUP BY 1 HAVING count(*) > 1`,
      csvEmails,
    );
    expect(dupes).toHaveLength(0);
  });

  it('um-seed-01 · mapped S1 fields match the CSV; workEmail stored trim+lowercase (DEC-UM-007) [RED: importer missing]', async () => {
    const csv = csvRows[0];
    const row = await prisma.user.findFirst({
      where: { workEmail: { equals: csv.Email, mode: 'insensitive' } },
    });
    expect(row).not.toBeNull();
    if (!row) return;

    expect(row.firstName).toBe(csv.FirstName);
    expect(row.lastName).toBe(csv.LastName);
    expect(row.position).toBe(csv.PositionName); // PositionName -> position (free-text S1)
    expect(row.country).toBe(csv.CountryName); // CountryName -> country
    expect(row.companyJoinDate.toISOString().slice(0, 10)).toBe(
      csv.RegistrationDate,
    ); // RegistrationDate -> companyJoinDate

    // DEC-UM-007: the writer stores the normalized value, not the raw CSV value.
    expect(row.workEmail).toBe(normalizeEmail(row.workEmail));
    expect(row.workEmail).toBe(normalizeEmail(csv.Email));

    // OPEN(spec): PositionId (positions dictionary?), DepartmentName/DepartmentId
    // (Department edge contract deferred), CountryCode/CountryStateName/CountryId,
    // EmployeeType (S4 — not on the User row), TimeZone, IsDismissed/DismissedDate
    // (employment status §4.16, not User.isActive directly). Not asserted here.
  });

  it('um-seed-01 · fields with no CSV source column come back null: workPhone / city / photo / ttId [RED: importer missing]', async () => {
    const csv = csvRows[0];
    const row = await prisma.user.findFirst({
      where: { workEmail: { equals: csv.Email, mode: 'insensitive' } },
    });
    expect(row).not.toBeNull();
    if (!row) return;

    expect(row.workPhone).toBeNull();
    expect(row.city).toBeNull();
    expect(row.photo).toBeNull();
    expect(row.ttId).toBeNull();
  });

  it('um-seed-01 · Birthday=NULL → birthDay and birthMonth both null (deliberate NULL, not the incomplete-pair rejection) [RED: importer missing]', async () => {
    const csv = csvRows[0];
    const row = await prisma.user.findFirst({
      where: { workEmail: { equals: csv.Email, mode: 'insensitive' } },
    });
    expect(row).not.toBeNull();
    if (!row) return;

    if (isCsvNull(csv.Birthday)) {
      expect(row.birthDay).toBeNull();
      expect(row.birthMonth).toBeNull();
    } else {
      // dated Birthday -> day (1-31) / month (1-12), year dropped everywhere.
      const d = new Date(csv.Birthday);
      expect(row.birthDay).toBe(d.getUTCDate());
      expect(row.birthMonth).toBe(d.getUTCMonth() + 1);
    }
  });

  it('um-seed-01 · each imported row persists customFields = {} (DB default, writer omits it — DEC-UM-003) [RED: importer missing]', async () => {
    const csv = csvRows[0];
    const row = await prisma.user.findFirst({
      where: { workEmail: { equals: csv.Email, mode: 'insensitive' } },
    });
    expect(row).not.toBeNull();
    expect(row?.customFields).toEqual({});
  });

  it('um-seed-01 · one joined_company system UserEvents row per imported row, same tx, eventDate = companyJoinDate [RED: no user_events table / UserEvents model]', async () => {
    expect(importRun.exitCode).toBe(0); // RED: importer missing

    expect(await relationExists(prisma, 'user_events')).toBe(true); // RED: model missing

    const csv = csvRows[0];
    const events = await prisma.$queryRawUnsafe<
      Array<{ type: string; source: string; eventDate: Date }>
    >(
      `SELECT e.type, e.source, e."eventDate"
         FROM "user_events" e
         JOIN users u ON u.id = e."userId"
        WHERE lower(trim(u."workEmail")) = $1`,
      normalizeEmail(csv.Email),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'joined_company',
      source: 'system',
    });
    expect(events[0].eventDate.toISOString().slice(0, 10)).toBe(
      csv.RegistrationDate,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-02 — there is no POST /users create path  (the one HTTP assertion)
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-02 · POST /users is absent or permanently rejected (e2e, HTTP)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const body = (email: string) => ({
    firstName: 'Nina',
    lastName: 'Volkova',
    position: 'QA Engineer',
    country: 'Poland',
    city: 'Krakow',
    workEmail: email,
    companyJoinDate: '2026-09-01',
  });

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  afterAll(async () => {
    try {
      await testApp.prisma.user.deleteMany({
        where: { workEmail: { startsWith: 'interim-root-' } },
      });
    } catch (error) {
      console.warn('[um-seed-02] interim-root sweep failed', error);
    }
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  const post = (email: string, authorization: string) =>
    request(testApp.app.getHttpServer())
      .post('/users')
      .set('authorization', authorization)
      .send(body(email));

  it('um-seed-02 Test 1 — HR-Admin session POST /users → 404/405, no row created [RED: route present, returns 201]', async () => {
    const email = fx.emailFor('seed02-hradmin-nina');
    const res = await post(email, bearer('Root'));

    expect([404, 405]).toContain(res.status);
    const created = await testApp.prisma.user.findFirst({
      where: { workEmail: { equals: email, mode: 'insensitive' } },
    });
    expect(created).toBeNull();
  });

  it('um-seed-02 Test 2 — unrelated active session POST /users → identical status/shape to Test 1 [RED: 403 today, i.e. reads as a permission denial]', async () => {
    const colin = await fx.user('seed02-colin');
    const email = fx.emailFor('seed02-unrelated-nina');

    const hrAdminRes = await post(
      fx.emailFor('seed02-cmp-nina'),
      bearer('Root'),
    );
    const unrelatedRes = await post(email, bearer(colin.id));

    // v1.5 note: absence of a create capability is not a permission denial and
    // must not read as one — the outcome must not vary by session.
    expect([404, 405]).toContain(unrelatedRes.status);
    expect(unrelatedRes.status).toBe(hrAdminRes.status);

    const created = await testApp.prisma.user.findFirst({
      where: { workEmail: { equals: email, mode: 'insensitive' } },
    });
    expect(created).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-seed-03 — bootstrap HR Admin present; import reuses the ACM-0 root id
// ───────────────────────────────────────────────────────────────────────────
describe('UM-SEED-03 · bootstrap HR Admin + root-id reuse on import (e2e, DB-state)', () => {
  const runId = `um-seed-03-${Date.now()}`;
  const rootEmail = normalizeEmail(`${runId}-root@company.example`);
  let seedRun: ScriptRun;
  let bootstrapRun: ScriptRun;
  let importRun: ScriptRun;
  let rootBefore: { id: string; createdBy: string } | null = null;
  let createdBootstrapFromEmpty = false;

  beforeAll(async () => {
    const bootstrapBefore = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "AccessControlBootstrap"`,
    );
    createdBootstrapFromEmpty = Number(bootstrapBefore[0].n) === 0;

    // Deployment order: db:deploy (already applied) -> db:seed (ACM-0) ->
    // db:bootstrap:access-control (ACM-1) -> population import (Story 1.1).
    // A whitespace/upper-case ROOT_WORK_EMAIL proves canonical-at-write.
    seedRun = await runScript('db:seed', {
      ROOT_WORK_EMAIL: `  ${rootEmail.toUpperCase()}  `,
    });
    bootstrapRun = await runScript('db:bootstrap:access-control', {
      ROOT_WORK_EMAIL: rootEmail,
    });

    const root = await prisma.user.findFirst({
      where: { workEmail: { equals: rootEmail, mode: 'insensitive' } },
      select: { id: true, createdBy: true },
    });
    rootBefore = root;

    // A CSV whose sole data row's Email normalizes to ROOT_WORK_EMAIL.
    const csv = writeTempPopulationCsv([
      {
        FirstName: 'Root',
        LastName: 'Administrator',
        Email: ` ${rootEmail.toUpperCase()} `,
        Birthday: 'NULL',
        PositionId: '2',
        PositionName: 'Developer',
        RegistrationDate: '2026-08-17',
        DepartmentId: '1',
        DepartmentName: 'JS',
        DismissedDate: 'NULL',
        IsDismissed: '0',
        EmployeeType: 'Employee',
        TimeZone: 'Europe/Kyiv',
        CountryId: '227',
        CountryCode: 'UA',
        CountryName: 'Ukraine',
        CountryStateId: 'NULL',
        CountryStateName: 'NULL',
      },
    ]);
    importRun = await runScript(IMPORT_SCRIPT, {
      ROOT_WORK_EMAIL: rootEmail,
      // Assumed override — see fixtures.IMPORT_SCRIPT.
      POPULATION_CSV: csv,
    });
  });

  afterAll(async () => {
    const rootId = rootBefore?.id;
    const teardown: Array<() => Promise<unknown>> = [
      () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "AccessControlBootstrap" WHERE "normalizedRootEmail" = $1`,
          rootEmail,
        ),
      () =>
        rootId
          ? prisma.$executeRawUnsafe(
              `DELETE FROM "UserPolicies" WHERE "userId" = $1`,
              rootId,
            )
          : Promise.resolve(),
      () =>
        prisma.user.deleteMany({
          where: { workEmail: { equals: rootEmail, mode: 'insensitive' } },
        }),
      // Only if THIS run created the bootstrap state from an empty table:
      // remove the `hr-admin` FR policy + its grants it left orphaned. If a
      // bootstrap row already existed, this is shared state — leave it.
      async () => {
        if (!createdBootstrapFromEmpty) return;
        const policies = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'`,
        );
        for (const { id } of policies) {
          const refs = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "UserPolicies" WHERE "policyId" = $1`,
            id,
          );
          if (Number(refs[0].n) > 0) continue;
          await prisma.$executeRawUnsafe(
            `DELETE FROM "PolicyPermissions" WHERE "policyId" = $1`,
            id,
          );
          await prisma.$executeRawUnsafe(
            `DELETE FROM "Policies" WHERE id = $1`,
            id,
          );
        }
      },
    ];
    for (const step of teardown) {
      try {
        await step();
      } catch (error) {
        console.warn('[um-seed-03] teardown step failed', error);
      }
    }
  });

  it('um-seed-03 · db:seed created exactly one active root User with the normalized workEmail [GREEN: ACM-0 characterization]', async () => {
    expect(seedRun.exitCode).toBe(0);
    const roots = await prisma.user.findMany({
      where: { workEmail: { equals: rootEmail, mode: 'insensitive' } },
    });
    expect(roots).toHaveLength(1);
    expect(roots[0].isActive).toBe(true);
    expect(roots[0].workEmail).toBe(rootEmail); // stored normalized, not the raw " UPPER "
  });

  it('um-seed-03 · db:bootstrap attached exactly one hr-admin FR policy to that one root row [GREEN: ACM-1 characterization]', async () => {
    expect(bootstrapRun.exitCode).toBe(0);
    const attachments = await prisma.$queryRawUnsafe<
      Array<{ userId: string; targetRole: string; type: string }>
    >(
      `SELECT up."userId", p."targetRole", p.type
         FROM "UserPolicies" up
         JOIN "Policies" p ON p.id = up."policyId"
        WHERE p.type = 'FR' AND p."targetRole" = 'hr-admin'
          AND up."userId" = (SELECT id FROM users WHERE lower(trim("workEmail")) = $1)`,
      rootEmail,
    );
    expect(attachments).toHaveLength(1);
  });

  it('um-seed-03 · a CSV row normalizing to ROOT_WORK_EMAIL updates the ACM-0 root in place — no second row, same id (DEC-UM-009) [RED: importer missing]', async () => {
    expect(importRun.exitCode).toBe(0); // RED: `npm run <IMPORT_SCRIPT>` missing

    const matches = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM users WHERE lower(trim("workEmail")) = $1`,
      rootEmail,
    );
    expect(Number(matches[0].n)).toBe(1);

    const rootAfter = await prisma.user.findFirst({
      where: { workEmail: { equals: rootEmail, mode: 'insensitive' } },
      select: { id: true, createdBy: true },
    });
    expect(rootAfter?.id).toBe(rootBefore?.id);
    expect(rootAfter?.createdBy).toBe(rootBefore?.createdBy);

    // Still exactly one hr-admin attachment, still the ACM-0 root id.
    const attachments = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n
         FROM "UserPolicies" up JOIN "Policies" p ON p.id = up."policyId"
        WHERE p.type = 'FR' AND p."targetRole" = 'hr-admin'
          AND up."userId" = $1`,
      rootBefore?.id ?? '',
    );
    expect(Number(attachments[0].n)).toBe(1);
  });

  it('um-seed-03 · the import creates no joined_company event for the root person (not inserted by the import) [RED: importer missing / no user_events model]', async () => {
    expect(importRun.exitCode).toBe(0); // RED: importer missing

    if (await relationExists(prisma, 'user_events')) {
      const events = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "user_events"
          WHERE "userId" = $1 AND type = 'joined_company'`,
        rootBefore?.id ?? '',
      );
      expect(Number(events[0].n)).toBe(0);
    }
  });
});
