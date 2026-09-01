import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  LIST_USERS_PERMISSION,
  RECORD_A_DEPARTURE_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  departureTable,
  employmentStatusTable,
  type TestApp,
} from './fixtures';

/**
 * Epic 5 — Employment Lifecycle · Story 5.2 (Apply an Effective Departure) ·
 * AD-1 Stage 2, committed red.
 *
 * BLOCKED — CC-06 (scheduled-departure state + effective-date executor +
 * idempotency) not approved. Route/body/blocker-check from api-conventions.md
 * ("Departure command and status (AD-20)") + AD-16 + AD-20. The
 * effective-date-apply assertions below encode the AD-20 target outcome and
 * WILL need revision when CC-06 lands. Written as real committed-red per the
 * human's "cover all of them" instruction.
 *
 * Scenarios: docs/test-cases/user-management/departure/
 *   um-dep-03-apply-on-effective-date.md
 *   um-dep-04-idempotent-retry.md
 *
 * WHY RED (per test):
 *   - all: **red-because-route-missing** — `POST /users/:id/departures`,
 *     `GET /users/:id/departures/:departureId`,
 *     `POST /users/:id/departures/:departureId/retry`, and
 *     `GET /users/:id/employment` are not implemented; every call 404s.
 *   - all: **BLOCKED-CC-06** — there is NO effective-date executor / worker to
 *     drive, NO clock seam, and NO `Departure` / `EmploymentStatus` schema.
 *     um-dep-03 needs the effective date reached: no controllable clock exists,
 *     so the closest real substitute is a back-dated `effectiveDate` (dueAt in
 *     the past) — the row would be immediately claim-eligible IF a worker
 *     existed. These assertions need a controllable clock or a back-dated
 *     `dueAt` once the CC-06 model lands. The scheduler is NOT faked.
 *   - the apply-outcome sub-`expect`s are additionally
 *     **red-because-executor-missing** and, for the access-cutoff check,
 *     **red-because-interim-adapter** (the interim `isAllowedForTarget` returns
 *     `true` for any caller until Epic 0 rebinds `ACCESS_CONTROL_PORT`).
 *   - the `departureTable` / `employmentStatusTable` markers are
 *     **red-because-model-missing**.
 *
 * A green here is NOT Story 5.2 acceptance.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown; `@concurrency` = parallel HTTP (`Promise.all`) in one test.
 * NFR-1: pseudonymised fixture data only.
 */
describe('Epic 5 · Story 5.2 — Apply an Effective Departure (e2e, committed red — BLOCKED CC-06)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();

  // Back-dated: dueAt resolves to the past, so the row is due the moment it is
  // written. Substitute for "the effective date has just been reached" — see
  // the file header (needs a controllable clock / back-dated dueAt once CC-06
  // lands; the executor to apply it does not exist).
  const PAST_EFFECTIVE_DATE = '2020-01-02';
  const REASON = 'relocation';

  const postDeparture = (
    userId: string,
    actorId: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) =>
    request(server())
      .post(`/users/${userId}/departures`)
      .set('authorization', bearer(actorId))
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  const retryDeparture = (
    userId: string,
    departureId: string,
    actorId: string,
  ) =>
    request(server())
      .post(`/users/${userId}/departures/${departureId}/retry`)
      .set('authorization', bearer(actorId));

  const readAs = (targetId: string, actorId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(actorId));

  const listDefault = (actorId: string) =>
    request(server())
      .get('/users')
      .query({ pageSize: 200 })
      .set('authorization', bearer(actorId));

  const seedActor = async (persona: string) => {
    const actor = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(actor.id, [
      RECORD_A_DEPARTURE_PERMISSION,
      LIST_USERS_PERMISSION,
    ]);
    return actor;
  };

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
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // um-dep-03 -------------------------------------------------------------
  it('um-dep-03 · on the effective date: dismissed + read-only + off default list (still filterable) + access ends + no career event', async () => {
    const actor = await seedActor('dep03-actor');
    const alice = await fx.user('dep03-alice');
    // Alice holds a project-line-style read: she is Bob's `direct` manager, so
    // today she resolves `reporting` over Bob (a request she "previously could
    // make"). Also gives her a management relation — the record-time blocker is
    // out of scope here (um-dep-02 owns it); this suite assumes a validly
    // scheduled departure per the scenario Given.
    const bob = await fx.user('dep03-bob');
    await fx.reportsTo(bob.id, alice.id);

    // Record the departure with a back-dated effective date (dueAt in the past).
    const created = await postDeparture(
      alice.id,
      actor.id,
      { effectiveDate: PAST_EFFECTIVE_DATE, reason: REASON },
      `dep03-${uuidv7()}`,
    );
    // BLOCKED-CC-06: `POST /departures` 404s today. The `departureId` a real
    // executor / status read would use comes from this response.
    expect(created.status).toBe(201);
    const departureId = (created.body as { id?: string }).id;

    // --- The CC-06 executor runs on dueAt. There is no executor and no clock
    // seam to advance; each assertion below is the AD-20 target outcome and
    // needs a controllable clock or back-dated dueAt once CC-06 lands. ---

    // (a) employment status → `dismissed`.
    const employment = await request(server())
      .get(`/users/${alice.id}/employment`)
      .set('authorization', bearer(actor.id));
    expect(employment.status).toBe(200);
    expect((employment.body as { status?: string }).status).toBe('dismissed');

    // (b) profile read-only for an entitled actor — a PATCH is refused.
    const patch = await request(server())
      .patch(`/users/${alice.id}`)
      .set('authorization', bearer(actor.id))
      .send({ city: 'Wroclaw' });
    expect([403, 409]).toContain(patch.status); // read-only, not 200

    // (c) absent from the default list, present under the authorized
    //     `?employmentStatus=dismissed` filter (list/um-list-05).
    const defaultList = await listDefault(actor.id);
    expect(defaultList.status).toBe(200);
    const defaultIds = (
      (defaultList.body as { items?: Array<{ id: string }> }).items ?? []
    ).map((u) => u.id);
    expect(defaultIds).not.toContain(alice.id);

    const filtered = await request(server())
      .get('/users')
      .query({ employmentStatus: 'dismissed', pageSize: 200 })
      .set('authorization', bearer(actor.id));
    expect(filtered.status).toBe(200);
    const filteredIds = (
      (filtered.body as { items?: Array<{ id: string }> }).items ?? []
    ).map((u) => u.id);
    expect(filteredIds).toContain(alice.id);

    // (d) every access Alice held ends immediately (overriding the 15-minute
    //     window). red-because-interim-adapter as well: the interim
    //     `isAllowedForTarget` is always `true`, so this is `200` today.
    const aliceReadsBob = await readAs(bob.id, alice.id);
    expect(aliceReadsBob.status).toBe(403);

    // (e) NO departure / left-company event on the career timeline (FR-11 —
    //     employment status is the sole source).
    const events = await request(server())
      .get(`/users/${alice.id}/events`)
      .set('authorization', bearer(actor.id));
    expect(events.status).toBe(200);
    const eventTypes = (
      (events.body as { items?: Array<{ type?: string }> }).items ?? []
    ).map((e) => e.type);
    expect(eventTypes).not.toContain('left_company');
    expect(eventTypes).not.toContain('departure');

    // (f) account deactivates (`isActive: false`) — the persisted convergence.
    // red-because-executor-missing: nothing flips this today.
    const aliceRow = await testApp.prisma.user.findUnique({
      where: { id: alice.id },
    });
    expect(aliceRow?.isActive).toBe(false);

    // Model markers — red-because-model-missing until CC-06 schema lands.
    expect(await departureTable(testApp.prisma)).not.toBeNull();
    expect(await employmentStatusTable(testApp.prisma)).not.toBeNull();

    // Silence unused-var lint when the POST 404s (departureId === undefined).
    void departureId;
  });

  // um-dep-04 -------------------------------------------------------------
  describe('um-dep-04 · retrying a partially-failed departure is idempotent', () => {
    it('Test 1 — retry via POST .../:departureId/retry → 202, each um-dep-03 effect present exactly once', async () => {
      const actor = await seedActor('dep04a-actor');
      const alice = await fx.user('dep04a-alice');

      const created = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: PAST_EFFECTIVE_DATE, reason: REASON },
        `dep04a-${uuidv7()}`,
      );
      expect(created.status).toBe(201);
      const departureId = (created.body as { id: string }).id;

      // BLOCKED-CC-06: a real `retry_wait` row needs the executor to have
      // partially run then failed/timed-out — unreachable without CC-06. This
      // exercises the retry ROUTE SHAPE only; api-conventions.md fixes
      // `retry_wait` → `202`.
      const retry = await retryDeparture(alice.id, departureId, actor.id);
      expect(retry.status).toBe(202);

      // Idempotency (once CC-06 lands and the executor completes the retry):
      // exactly one `dismissed` interval, no action item cancelled twice, no
      // mentorship pair closed twice, no duplicate journal / system-note.
      // Asserted here as "employment status resolves to a single `dismissed`".
      const employment = await request(server())
        .get(`/users/${alice.id}/employment`)
        .set('authorization', bearer(actor.id));
      expect(employment.status).toBe(200);
      expect((employment.body as { status?: string }).status).toBe('dismissed');
      // A history read (if exposed) must show one dismissed transition, not two.
      const history = (employment.body as { history?: unknown[] }).history;
      if (Array.isArray(history)) {
        const dismissals = history.filter(
          (h) => (h as { status?: string }).status === 'dismissed',
        );
        expect(dismissals).toHaveLength(1);
      }
    });

    it('Test 2 — retry a non-retryable state (not `retry_wait`) → 409, no additional effect', async () => {
      const actor = await seedActor('dep04b-actor');
      const alice = await fx.user('dep04b-alice');

      const created = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: PAST_EFFECTIVE_DATE, reason: REASON },
        `dep04b-${uuidv7()}`,
      );
      expect(created.status).toBe(201);
      const departureId = (created.body as { id: string }).id;

      // The scenario doc names `applied`; that state is unreachable without the
      // CC-06 executor. A freshly-recorded row is `scheduled`, and
      // api-conventions.md says retry "accepts only `retry_wait`" — `processing`
      // or `applied` returns `409`, and by the same rule so does `scheduled`.
      // We assert the reachable non-retryable state here.
      const retry = await retryDeparture(alice.id, departureId, actor.id);
      expect(retry.status).toBe(409);
    });

    it('Test 3 — @concurrency: two parallel retries → at most one 202, final effect set applied exactly once', async () => {
      const actor = await seedActor('dep04c-actor');
      const alice = await fx.user('dep04c-alice');

      const created = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: PAST_EFFECTIVE_DATE, reason: REASON },
        `dep04c-${uuidv7()}`,
      );
      expect(created.status).toBe(201);
      const departureId = (created.body as { id: string }).id;

      // DEC-UM-010: parallel HTTP in one test, one worker. AD-20 claim/fencing
      // guarantees exactly one executor proceeds.
      const [a, b] = await Promise.all([
        retryDeparture(alice.id, departureId, actor.id),
        retryDeparture(alice.id, departureId, actor.id),
      ]);

      const accepted = [a.status, b.status].filter((s) => s === 202);
      expect(accepted.length).toBeLessThanOrEqual(1);

      // Convergence: employment status is a single `dismissed`, not doubled.
      const employment = await request(server())
        .get(`/users/${alice.id}/employment`)
        .set('authorization', bearer(actor.id));
      expect(employment.status).toBe(200);
      expect((employment.body as { status?: string }).status).toBe('dismissed');
    });
  });
});
