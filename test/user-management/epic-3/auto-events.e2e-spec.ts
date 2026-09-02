import request from 'supertest';
import { uuidv7 } from 'uuidv7';
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
 * Scenarios (one E2E describe per scenario, id in the test titles):
 *   docs/test-cases/user-management/career-timeline/
 *     um-ct-01-system-generates-joined-company-on-create.md  -> import-triggered
 *     um-ct-02-system-generates-position-change-on-edit.md   -> PATCH-triggered
 *   (um-ct-11 — the GET /users/:id/events read-audience matrix — lives in
 *    timeline-read-audience.e2e-spec.ts; it is a read-authorization suite, not a
 *    DB-state suite.)
 *
 * ── Current production reality (why these are red for the RIGHT reason) ─────
 *
 *  - The `UserEvent` Prisma model + `user_events` table now EXIST (Story 1.1,
 *    migration 20260902001941_story_1_1_import_population). `eventDate` is
 *    `@db.Date` (a DATE, not a timestamp).
 *  - `joined_company` IS already written at import, in the same transaction
 *    (`population-import.repository.ts`). So um-ct-01's DB-state assertions may
 *    PASS — Story 1.1 delivered that half. um-ct-01's approved scenario Test
 *    reads `GET /users/:id/events`, which does NOT exist -> that read keeps
 *    um-ct-01 red on the missing read surface.
 *  - `position_change` hook: does NOT exist. `EditUserAction` makes no
 *    `UserEvents` write -> um-ct-02 Test 1 red on the missing event.
 *  - `GET /users/:id/events`: does NOT exist -> 404 -> um-ct-01 route read and
 *    um-ct-02 route read both red.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. The population import is executed as its real (future) production
 * entrypoint, never reproduced inline. DEC-UM-010: one worker, run-namespaced
 * data, wrapped scoped teardown (events -> relationships -> users).
 */

// ───────────────────────────────────────────────────────────────────────────
// um-ct-01 — the population import writes a joined_company system event
// ───────────────────────────────────────────────────────────────────────────
describe('UM-CT-01 · population import → one joined_company system event per imported User (e2e)', () => {
  const prisma = rawPrisma();
  const { rows: csvRows } = readSemicolonCsv(POPULATION_CSV_PATH);
  const csvEmails = csvRows.map((r) => normalizeEmail(r.Email));
  let importRun: ScriptRun;
  let testApp: TestApp;

  beforeAll(async () => {
    // Precondition = "the population import runs to completion" (um-ct-01's
    // stateChange: the import is the trigger — there is no separate request that
    // writes the event). Its production entrypoint is invoked here.
    importRun = await runScript(IMPORT_SCRIPT);
    testApp = await bootstrapTestApp();
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
    await testApp.app.close();
    await testApp.moduleFixture.close();
    await prisma.$disconnect();
  });

  it(
    'um-ct-01 · the population import runs to completion [RED-or-GREEN: passes iff `npm run ' +
      IMPORT_SCRIPT +
      '` exists and succeeds]',
    () => {
      expect(importRun.exitCode).toBe(0);
    },
  );

  it('um-ct-01 · exactly one joined_company system event per imported row, eventDate = companyJoinDate, same tx [RED iff importer missing; GREEN half delivered by Story 1.1]', async () => {
    expect(importRun.exitCode).toBe(0);
    expect(await relationExists(prisma, 'user_events')).toBe(true);

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

  it('um-ct-01 · GET /users/:id/events returns the joined_company event to Root [RED: route GET /users/:id/events does not exist → 404]', async () => {
    // um-ct-01's approved Test: inputURL `GET /users/<ninaId>/events`,
    // `Bearer <token:Root>`, expected `200` with exactly one
    // `{ type: "joined_company", source: "system" }` event. Resolve the real
    // imported id so the assertion goes green the moment Story 3.1 adds the
    // route; fall back to a random uuid (still 404) if the import did not run.
    const csv = csvRows[0];
    const imported = await testApp.prisma.user.findFirst({
      where: {
        workEmail: { equals: normalizeEmail(csv.Email), mode: 'insensitive' },
      },
    });
    const targetId = imported?.id ?? uuidv7();

    // Story 3.1 impl note (2026-09-02): the scenario's `Bearer <token:Root>` is
    // the one place this suite's auth identity contradicts the *authoritative*
    // read-audience matrix (`um-ct-11`). `Root` (HR Admin) has no relationship
    // edge to an arbitrarily-imported employee, so the career-timeline S9 read
    // gate resolves `Root` as Colleague — which `um-ct-11` Test 4 requires to be
    // `403`, not `200` (S9 excludes Colleague; the §2.4 full-profile-access
    // overlay that would let an admin read every timeline is deferred/unbuilt).
    // The scenario's actual claim — "the import writes `joined_company`,
    // observable via `GET /users/:id/events` as the `{ data, canEdit }`
    // envelope" — is unchanged; only the reader becomes Self (200 per `um-ct-11`
    // Test 1), mirroring the retired UM-AC-vibe career-timeline suite which also
    // read `um-ct-01` as `bearer(nina.id)`.
    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${targetId}/events`)
      .set('authorization', bearer(targetId));

    // Stage-2 gate decision (Dmytro 2026-09-02): the response is the standard
    // `{ data, canEdit }` envelope. `canEdit` is the Story 3.2/3.3 manual-
    // mutation gate — `false` for every viewer until Story 3.2 ships.
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; canEdit: boolean };
    expect(body).toMatchObject({ canEdit: false });
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'joined_company',
          source: 'system',
        }),
      ]),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// um-ct-02 — editing position writes a position_change system event
// ───────────────────────────────────────────────────────────────────────────
describe('UM-CT-02 · PATCH /users/:id position edit → position_change system event (e2e)', () => {
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

  it('um-ct-02 Test 1 · a real position PATCH writes a system position_change event, details = new value only, eventDate = today UTC, same committed tx [RED: no hook in EditUserAction]', async () => {
    // Preconditions are real Prisma inserts (no `POST /users` in v1.5): Alice
    // seeded position "Engineer"; Bob is her direct manager via a real `direct`
    // edge (the mechanic of profile/um-edit-01, NOT the retired um-pf-01). The
    // interim adapter permits the S1 write regardless; Epic 0 makes the edge
    // load-bearing.
    const bob = await fx.user('ct02-bob', { firstName: 'Bob' });
    const alice = await fx.user('ct02-alice', {
      firstName: 'Alice',
      position: 'Engineer',
    });
    await fx.reportsTo(alice.id, bob.id);

    // The trigger (um-ct-02 stateChange: the real `PATCH /users/:id` from
    // um-edit-01 — no separate request produces the event).
    const write = await request(testApp.app.getHttpServer())
      .patch(`/users/${alice.id}`)
      .set('authorization', bearer(bob.id))
      .send({ position: 'Senior Engineer' });
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({ position: 'Senior Engineer' });

    // AD-11: the event must have been written synchronously, same transaction —
    // so it is already visible on a plain committed read here.
    expect(await userEventsTableExists(testApp.prisma)).toBe(true);

    const events = await queryUserEvents(testApp.prisma, alice.id);
    const positionChange = events.find((e) => e.type === 'position_change');
    expect(positionChange).toBeDefined();
    expect(positionChange).toMatchObject({
      type: 'position_change',
      source: 'system',
    });
    // Approved scenario: details carries the NEW VALUE ONLY — no from/previous.
    expect(positionChange?.details).toEqual({ position: 'Senior Engineer' });
    // Approved scenario: eventDate = today's date in UTC (the column is DATE),
    // not a to-the-second timestamp.
    const todayUtc = new Date().toISOString().slice(0, 10);
    expect(positionChange?.eventDate.toISOString().slice(0, 10)).toBe(todayUtc);
  });

  it('um-ct-02 Test 1 (read surface) · GET /users/:id/events surfaces the position_change to Bob [RED: route GET /users/:id/events does not exist → 404]', async () => {
    const bob = await fx.user('ct02r-bob', { firstName: 'Bob' });
    const alice = await fx.user('ct02r-alice', {
      firstName: 'Alice',
      position: 'Engineer',
    });
    await fx.reportsTo(alice.id, bob.id);

    await request(testApp.app.getHttpServer())
      .patch(`/users/${alice.id}`)
      .set('authorization', bearer(bob.id))
      .send({ position: 'Senior Engineer' });

    const res = await request(testApp.app.getHttpServer())
      .get(`/users/${alice.id}/events`)
      .set('authorization', bearer(bob.id));

    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[]; canEdit: boolean };
    expect(body).toMatchObject({ canEdit: false });
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'position_change',
          source: 'system',
          details: { position: 'Senior Engineer' },
        }),
      ]),
    );
  });

  it('um-ct-02 Test 2 · a no-op position edit (same value, then position absent) writes NO additional position_change event [RED: no hook — currently zero events, target is exactly one]', async () => {
    const bob = await fx.user('ct02b-bob', { firstName: 'Bob' });
    const alice = await fx.user('ct02b-alice', {
      firstName: 'Alice',
      position: 'Engineer',
    });
    await fx.reportsTo(alice.id, bob.id);

    const patch = (body: Record<string, unknown>) =>
      request(testApp.app.getHttpServer())
        .patch(`/users/${alice.id}`)
        .set('authorization', bearer(bob.id))
        .send(body);

    // 1. Real change Engineer -> Senior Engineer: one position_change.
    expect((await patch({ position: 'Senior Engineer' })).status).toBe(200);
    // 2. Same value again: no new event.
    expect((await patch({ position: 'Senior Engineer' })).status).toBe(200);
    // 3. `position` absent from the body entirely: no new event.
    expect((await patch({ city: 'Gdansk' })).status).toBe(200);

    const positionChanges = (
      await queryUserEvents(testApp.prisma, alice.id)
    ).filter((e) => e.type === 'position_change');
    expect(positionChanges).toHaveLength(1);
  });
});
