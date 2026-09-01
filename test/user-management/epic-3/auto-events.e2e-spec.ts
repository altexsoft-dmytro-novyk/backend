import request from 'supertest';
import {
  IMPORT_SCRIPT,
  POPULATION_CSV_PATH,
  RunFixtures,
  type ScriptRun,
  type TestApp,
  bearer,
  bootstrapTestApp,
  cleanupUserEvents,
  normalizeEmail,
  queryUserEvents,
  rawPrisma,
  readSemicolonCsv,
  relationExists,
  runScript,
  userEventsTableExists,
} from './fixtures';

/**
 * Epic 3 — Story 3.1 (System Auto-Generates Career Timeline Events) · AD-1
 * Stage 2, committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/career-timeline/
 *     um-ct-01-system-generates-joined-company-on-create.md  -> DB-state, import-triggered
 *     um-ct-02-system-generates-position-change-on-edit.md   -> DB-state, PATCH-triggered
 *
 * Both scenarios are DB-state assertions: `GET /users/:id/events` (Story 3.1's
 * read surface) does not exist yet, and neither does the `UserEvents` Prisma
 * model / `user_events` table — so `prisma.userEvent` is not a compilable
 * accessor and every probe is raw SQL against the not-yet-created relation.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *
 *  um-ct-01  RED — red-because-model-missing AND red-because-not-implemented.
 *            The trigger is Story 1.1's population import (v1.5: `joined_company`
 *            fires at import, NOT on any HTTP create — the `POST /users` route is
 *            retired). `npm run <IMPORT_SCRIPT>` does not exist, so it exits
 *            non-zero and no imported row exists; the `user_events` table does
 *            not exist, so the event query has nothing to hit. Deliberately
 *            overlaps `epic-1/seed.e2e-spec.ts` um-seed-01's last assertion —
 *            same target behaviour, asserted from the Epic 3 side per the
 *            dispatch ("coordinate with Epic 1's seed/ suite approach").
 *
 *  um-ct-02  RED — red-because-model-missing AND red-because-wrong-behaviour.
 *            `PATCH /users/:id` IS wired and the interim adapter permits the
 *            write (200, position persists), but `EditUserAction` makes NO
 *            `UserEvents` write — there is no same-transaction hook (AD-11) and
 *            no model to write to. The position-change assertion fails on the
 *            missing relation; when Story 3.1 lands the hook + model it goes
 *            green.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. The population import is executed as its real (future) production
 * entrypoint, never reproduced inline. DEC-UM-010: one worker, run-namespaced
 * data, wrapped scoped teardown (events -> relationships -> users).
 */

// ───────────────────────────────────────────────────────────────────────────
// um-ct-01 — the population import writes a joined_company system event
// ───────────────────────────────────────────────────────────────────────────
describe('UM-CT-01 · population import → one joined_company system event per imported User (e2e, DB-state)', () => {
  const prisma = rawPrisma();
  const { rows: csvRows } = readSemicolonCsv(POPULATION_CSV_PATH);
  const csvEmails = csvRows.map((r) => normalizeEmail(r.Email));
  let importRun: ScriptRun;

  beforeAll(async () => {
    // Precondition = "the population import runs to completion" (um-ct-01's
    // stateChange: the import is the trigger — there is no separate request that
    // writes the event). Its production entrypoint is invoked here; it does not
    // exist yet, so this run fails and every assertion downstream is
    // committed-red on it.
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
        console.warn('[um-ct-01] teardown step failed', error);
      }
    }
    await prisma.$disconnect();
  });

  it(
    'um-ct-01 · the population import runs to completion [RED: no importer — `npm run ' +
      IMPORT_SCRIPT +
      '` is missing]',
    () => {
      expect(importRun.exitCode).toBe(0);
    },
  );

  it('um-ct-01 · exactly one joined_company system event per imported row, eventDate = companyJoinDate, same tx [RED: no user_events model / no importer]', async () => {
    expect(importRun.exitCode).toBe(0); // RED: importer missing
    expect(await relationExists(prisma, 'user_events')).toBe(true); // RED: UserEvents model missing

    const csv = csvRows[0];
    const events = await prisma.$queryRawUnsafe<
      Array<{ type: string; source: string; eventDate: Date }>
    >(
      `SELECT e.type, e.source, e."eventDate"
         FROM "user_events" e
         JOIN users u ON u.id = e."userId"
        WHERE lower(trim(u."workEmail")) = $1 AND e."deletedAt" IS NULL`,
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
// um-ct-02 — editing position writes a position_change system event
// ───────────────────────────────────────────────────────────────────────────
describe('UM-CT-02 · PATCH /users/:id position edit → position_change system event (e2e, DB-state)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await cleanupUserEvents(testApp.prisma, fx.userIds);
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  it('um-ct-02 · a real position PATCH writes a system position_change event with details {from,to} in the same committed tx [RED: no user_events model, no hook in EditUserAction]', async () => {
    // Preconditions are real Prisma inserts (no `POST /users` in v1.5): Alice
    // seeded position "Engineer"; Bob is her direct Unit Manager via a real
    // `direct` edge so the S1 write is as authorized as it can be (the interim
    // adapter permits it regardless; Epic 0 makes the edge load-bearing).
    const bob = await fx.user('ct02-bob', { firstName: 'Bob' });
    const alice = await fx.user('ct02-alice', {
      firstName: 'Alice',
      position: 'Engineer',
    });
    await fx.reportsTo(alice.id, bob.id);

    // The trigger (um-ct-02 stateChange: the `PATCH /users/<aliceId>` from
    // um-pf-01 is the trigger — no separate request produces the event).
    const write = await request(testApp.app.getHttpServer())
      .patch(`/users/${alice.id}`)
      .set('authorization', bearer(bob.id))
      .send({ position: 'Senior Engineer' });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ position: 'Senior Engineer' });

    // AD-11: the event must have been written synchronously, same transaction —
    // so it is already visible on a plain committed read here.
    expect(await userEventsTableExists(testApp.prisma)).toBe(true); // RED: UserEvents model missing

    const events = await queryUserEvents(testApp.prisma, alice.id);
    const positionChange = events.find((e) => e.type === 'position_change');
    expect(positionChange).toBeDefined();
    expect(positionChange).toMatchObject({
      type: 'position_change',
      source: 'system',
    });
    expect(positionChange?.details).toEqual({
      from: 'Engineer',
      to: 'Senior Engineer',
    });
  });
});
