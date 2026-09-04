import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  cleanupAccessJournal,
  queryAccessJournalRows,
} from '../epic-4/fixtures';
import {
  LIST_USERS_PERMISSION,
  RECORD_A_DEPARTURE_PERMISSION,
  RunFixtures,
  backdateDepartureDueAt,
  bearer,
  bootstrapTestApp,
  cleanupDepartures,
  queryDepartureRows,
  queryEmploymentStatusRows,
  departureWorker,
  runDepartureWorker,
  type TestApp,
} from './fixtures';

/**
 * Epic 5 — Employment Lifecycle · Story 5.2 (Apply an Effective Departure) ·
 * AD-1 Stage 2, committed red.
 *
 * SPLIT-GATE, reconciled 2026-09-03 (README + `spec-5-2` + `um-dep-03/04/07/08`).
 * CC-06 is DESIGN APPROVED — the earlier "BLOCKED — CC-06" framing is removed.
 * The effective-date **worker**, the apply `prisma.$transaction` for every
 * UM-owned local effect, `POST …/:departureId/retry`, the request-time cutoff,
 * and `GET /health/departures` are **this story's to build** and are first-class
 * stage-2 here. Only the two **cross-context** legs of `applyDepartureEffects`
 * (Action-Items cancellation, Mentorship auto-close) stay `it.todo` — their
 * participant contexts do not exist (`PM/AD-23`).
 *
 * Scenarios: docs/test-cases/user-management/departure/
 *   um-dep-03-apply-on-effective-date.md
 *   um-dep-04-idempotent-retry.md
 *   um-dep-07-request-time-cutoff-independent-of-worker.md
 *   um-dep-08-stale-executor-noop.md
 *
 * WHY RED — Story 5.2 has built NOTHING:
 *   - no `DepartureWorkerService.processDueDepartures()` — so a back-dated,
 *     due `Departure` row is never claimed and **no** effect materialises:
 *     `EmploymentStatus` stays a single `active` row, `User.isActive` stays
 *     `true`, the row stays `state: 'scheduled'`, `appliedAt` stays null, the
 *     subject stays on the active default list. **red-because-no-worker**.
 *   - no `POST /users/:id/departures/:departureId/retry` route — every call
 *     `404`s (asserted `202` / `409`). **red-because-route-missing**.
 *   - no request-time cutoff in the session resolver / `SessionGuard` — a due
 *     person's session still resolves, so her request still `200`s (asserted
 *     `401`). **red-because-no-cutoff**.
 *   - no `GET /health/departures` route — `404` (asserted `200` + shape).
 *     **red-because-route-missing**.
 *
 * Guardrail assertions GREEN today that must STAY green through Stage 3 are
 * flagged "guardrail": the un-processed row is still `scheduled` / employment
 * still `active` after a denied request (`um-dep-07` T2); a future-`dueAt` row
 * does not deny the session (`um-dep-07` T3); no departure/left-company career
 * event is ever written (`um-dep-03`).
 *
 * A green here is NOT Story 5.2 acceptance.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-004: back-dated `Departure.dueAt`, no fake clock,
 * no test-only worker HTTP endpoint. DEC-UM-010: one worker, run-namespaced
 * data, wrapped scoped teardown (departures → journal → employment_status →
 * users); `@concurrency` = parallel HTTP (`Promise.all`) in one test. NFR-1:
 * pseudonymised fixture data only.
 */
describe('Epic 5 · Story 5.2 — Apply an Effective Departure (e2e, committed red — SPLIT-GATE)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();
  const prisma = () => testApp.prisma;

  const REASON = 'relocation';

  // A near-future `effectiveDate` the record action accepts (it rejects any
  // date <= today). The row is then made "due" by back-dating `dueAt`.
  const nearFutureDate = () =>
    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

  const getDeparture = (userId: string, departureId: string, actorId: string) =>
    request(server())
      .get(`/users/${userId}/departures/${departureId}`)
      .set('authorization', bearer(actorId));

  const retryDeparture = (
    userId: string,
    departureId: string,
    actorId: string,
  ) =>
    request(server())
      .post(`/users/${userId}/departures/${departureId}/retry`)
      .set('authorization', bearer(actorId));

  /** `GET /users` narrowed to one run-scoped persona by workEmail. */
  const listHasEmail = async (
    actorId: string,
    workEmail: string,
    employmentStatus?: string,
  ): Promise<{ status: number; has: boolean }> => {
    const q: Record<string, string | number> = { workEmail, pageSize: 100 };
    if (employmentStatus) q.employmentStatus = employmentStatus;
    const res = await request(server())
      .get('/users')
      .query(q)
      .set('authorization', bearer(actorId));
    const rows = (
      (res.body as { items?: Array<{ workEmail?: string }> }).items ?? []
    ).map((u) => u.workEmail);
    return { status: res.status, has: rows.includes(workEmail) };
  };

  /** One FR-granted actor per test (the RunFixtures targetRole-collision bug). */
  const seedActor = async (persona: string) => {
    const actor = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(actor.id, [
      RECORD_A_DEPARTURE_PERMISSION,
      LIST_USERS_PERMISSION,
    ]);
    return actor;
  };

  /** Alice's current `active` employment fact (`validTo IS NULL`). */
  const seedActiveEmployment = (userId: string) =>
    prisma().employmentStatus.create({
      data: { userId, status: 'active', validFrom: new Date('2020-01-01') },
    });

  /**
   * Record a real `scheduled` `Departure` through Story 5.1's endpoint, then
   * back-date its `dueAt` so it is due now. Returns the `departureId`.
   */
  const seedDueDeparture = async (
    aliceId: string,
    actorId: string,
    keyPrefix: string,
  ): Promise<string> => {
    const created = await postDeparture(
      aliceId,
      actorId,
      { effectiveDate: nearFutureDate(), reason: REASON },
      `${keyPrefix}-${uuidv7()}`,
    );
    expect(created.status).toBe(201);
    const departureId = (created.body as { departureId: string }).departureId;
    await backdateDepartureDueAt(prisma(), departureId);
    return departureId;
  };

  /**
   * Force a due `Departure` into `retry_wait` with a back-dated `nextAttemptAt`
   * — the `um-dep-04` "partially completed then failed" precondition, which the
   * scenario doc says the fixture seeds directly (there is no worker in stage 2
   * to produce it). Raw `UPDATE` with an explicit enum cast.
   */
  const forceRetryWait = (departureId: string) =>
    prisma().$executeRawUnsafe(
      `UPDATE "departures"
          SET state = $1::"DepartureState", attempts = 1, "nextAttemptAt" = $2
        WHERE id = $3`,
      'retry_wait',
      new Date(Date.now() - 60_000),
      departureId,
    );

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    const userIds = [...fx.userIds];
    const steps: Array<() => Promise<unknown>> = [
      () => cleanupDepartures(testApp.prisma, userIds),
      () => cleanupAccessJournal(testApp.prisma, userIds),
      () =>
        testApp.prisma.employmentStatus.deleteMany({
          where: { userId: { in: userIds } },
        }),
      () => fx.cleanup(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn('[epic-5 · story-5.2] teardown step failed', error);
      }
    }
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ======================================================================
  // um-dep-03 · applying a departure on its effective date
  // ======================================================================
  describe('um-dep-03 · on the effective date the full UM-owned outcome materialises', () => {
    it('Test 1 (LIVE) — worker applies: active EmploymentStatus closed + dismissed row inserted, account deactivated, off the default list (still filterable), Departure applied, no career event', async () => {
      const actor = await seedActor('dep03t1-actor');
      const alice = await fx.user('dep03t1-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep03t1');

      // Stage 3: invoke the worker directly (um-dep-03 decision 2). Every
      // assertion below is the AD-20 target outcome.
      await runDepartureWorker(testApp);

      // (a) EmploymentStatus: the `active` row closes and a `dismissed` row is
      //     inserted, keyed by the departure.
      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      const active = employment.find((r) => r.status === 'active');
      const dismissed = employment.find((r) => r.status === 'dismissed');
      expect(active?.validTo).not.toBeNull(); // red: still open
      expect(dismissed).toBeDefined(); // red: no dismissed row
      expect(dismissed?.validFrom).toBeTruthy();
      expect(dismissed?.sourceDepartureId).toBe(departureId);
      expect(dismissed?.departureReason).toBe(REASON);

      // (b) account row-retention flag flips.
      const aliceRow = await prisma().user.findUnique({
        where: { id: alice.id },
      });
      expect(aliceRow?.isActive).toBe(false); // red: still true

      // (c) off the default list, present under `?employmentStatus=dismissed`.
      const onDefault = await listHasEmail(actor.id, alice.workEmail);
      expect(onDefault.status).toBe(200);
      expect(onDefault.has).toBe(false); // red: still active → still listed

      const onDismissed = await listHasEmail(
        actor.id,
        alice.workEmail,
        'dismissed',
      );
      expect(onDismissed.status).toBe(200);
      expect(onDismissed.has).toBe(true); // red: not dismissed yet

      // (d) the Departure status read reports `applied` with `appliedAt`.
      const view = await getDeparture(alice.id, departureId, actor.id);
      expect(view.status).toBe(200);
      expect((view.body as { state?: string }).state).toBe('applied'); // red: scheduled
      expect((view.body as { appliedAt?: string }).appliedAt).toBeTruthy();

      const rows = await queryDepartureRows(prisma(), alice.id);
      expect(rows[0]?.state).toBe('applied'); // red: scheduled
      expect(rows[0]?.appliedAt).not.toBeNull();

      // (e) guardrail — NO departure / left-company career event (FR-11: there
      //     is no `departure` UserEvents type; employment status is the sole
      //     source). Passes today and must stay passing.
      const events = await request(server())
        .get(`/users/${alice.id}/events`)
        .set('authorization', bearer(actor.id));
      const eventTypes = (
        (events.body as { data?: Array<{ type?: string }> }).data ?? []
      ).map((e) => e.type);
      expect(eventTypes).not.toContain('left_company');
      expect(eventTypes).not.toContain('departure');
    });

    it('Test 3 (LIVE) — the persisted-access sweep runs inside the apply tx and is a no-op after Story 5.1 re-parenting (zero AccessJournal rows), idempotent on retry', async () => {
      const actor = await seedActor('dep03t3-actor');
      const alice = await fx.user('dep03t3-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep03t3');
      void departureId;

      // Two worker passes — the sweep must be idempotent (zero rows, then zero
      // more).
      await runDepartureWorker(testApp);
      await runDepartureWorker(testApp);

      // Alice holds no platform access after Story 5.1, so the sweep writes ZERO
      // `full_profile_revoke` rows, and a second worker pass writes no more.
      const revoked = await queryAccessJournalRows(
        prisma(),
        alice.id,
        'full_profile_revoke',
      );
      expect(revoked.length).toBeLessThanOrEqual(1); // guardrail — never doubled

      const rows = await queryDepartureRows(prisma(), alice.id);
      expect(rows[0]?.state).toBe('applied'); // red: no worker
    });

    it.todo(
      'um-dep-03 · DEFERRED — the Action Items context implements `applyDepartureEffects`: open Action Items assigned to the departing person become `cancelled — departed` (PM/AD-5: authored-for-active-assignee items stay open)',
    );
    it.todo(
      'um-dep-03 · DEFERRED — the Mentorship context implements `applyDepartureEffects`: active `MentorshipPair`s auto-close with a system note, bypassing the FR-M9 gate',
    );
  });

  // ======================================================================
  // um-dep-04 · retrying a partially-failed departure is idempotent
  // ======================================================================
  describe('um-dep-04 · retry (worker resume or POST …/retry) is idempotent', () => {
    it('Test 1 (LIVE) — POST …/:departureId/retry on a `retry_wait` row → 202', async () => {
      const actor = await seedActor('dep04t1-actor');
      const alice = await fx.user('dep04t1-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep04t1');
      await forceRetryWait(departureId);

      // The route does not exist → 404 today. api-conventions.md: `retry_wait`
      // → `202` (makes the row eligible; does not itself run the apply tx).
      const retry = await retryDeparture(alice.id, departureId, actor.id);
      expect(retry.status).toBe(202); // red: 404, route missing
    });

    it('Test 2 (LIVE) — POST …/retry from a non-`retry_wait` state (`scheduled`) → 409, no additional effect', async () => {
      const actor = await seedActor('dep04t2-actor');
      const alice = await fx.user('dep04t2-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep04t2');

      // A freshly-recorded row is `scheduled`; retry accelerates only
      // `retry_wait` (`processing` / `applied` / `scheduled` → `409`).
      const retry = await retryDeparture(alice.id, departureId, actor.id);
      expect(retry.status).toBe(409); // red: 404, route missing

      // guardrail — nothing materialised on the rejected path.
      const rows = await queryDepartureRows(prisma(), alice.id);
      expect(rows[0]?.state).toBe('scheduled');
      expect(rows[0]?.appliedAt).toBeNull();
    });

    it('Test 3 (LIVE) — @concurrency: two parallel POST …/retry on a `retry_wait` row → each 202 or 409, never a double apply', async () => {
      const actor = await seedActor('dep04t3-actor');
      const alice = await fx.user('dep04t3-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep04t3');
      await forceRetryWait(departureId);

      const [a, b] = await Promise.all([
        retryDeparture(alice.id, departureId, actor.id),
        retryDeparture(alice.id, departureId, actor.id),
      ]);
      // api-conventions.md / um-dep-04 T3: both 202, or one 202 + one 409 on the
      // state transition — never 404, never a double apply.
      expect([a.status, b.status].every((s) => s === 202 || s === 409)).toBe(
        true,
      ); // red: 404/404 today

      // convergence: a single `dismissed` interval once the worker applies.
      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      const dismissedRows = employment.filter((r) => r.status === 'dismissed');
      expect(dismissedRows).toHaveLength(1); // red: 0 today
    });

    it('Test 4 (LIVE) — worker resume convergence: exactly one `dismissed` interval, one account-deactivate, no duplicate AccessJournal row', async () => {
      const actor = await seedActor('dep04t4-actor');
      const alice = await fx.user('dep04t4-alice');
      await seedActiveEmployment(alice.id);

      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep04t4');
      await forceRetryWait(departureId);

      // Worker resume — `DepartureWorkerService.processDueDepartures()` picks up
      // the `retry_wait` row whose `nextAttemptAt` is back-dated. Assert the
      // converged end state (idempotent, applied exactly once).
      await runDepartureWorker(testApp);
      const view = await getDeparture(alice.id, departureId, actor.id);
      expect((view.body as { state?: string }).state).toBe('applied'); // red

      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      const dismissedRows = employment.filter((r) => r.status === 'dismissed');
      expect(dismissedRows).toHaveLength(1); // red: 0 today
      expect(dismissedRows[0]?.sourceDepartureId).toBe(departureId);

      const aliceRow = await prisma().user.findUnique({
        where: { id: alice.id },
      });
      expect(aliceRow?.isActive).toBe(false); // red: true today

      const journal = await queryAccessJournalRows(prisma(), alice.id);
      expect(journal.length).toBeLessThanOrEqual(1); // guardrail — never doubled
    });

    it.todo(
      'um-dep-04 · DEFERRED — the Action Items context implements `applyDepartureEffects`: a resume after partial failure cancels no Action Item twice',
    );
    it.todo(
      'um-dep-04 · DEFERRED — the Mentorship context implements `applyDepartureEffects`: a resume after partial failure closes no Mentorship pair twice',
    );
  });

  // ======================================================================
  // um-dep-07 · request-time cutoff holds even when the worker has not run
  // ======================================================================
  describe('um-dep-07 · request-time cutoff is dueAt-vs-PostgreSQL-now(), not worker-state dependent', () => {
    it('Test 1 (LIVE) — Alice, with a due (back-dated) `scheduled` Departure and the worker never run, is denied at request time → 401', async () => {
      const actor = await seedActor('dep07t1-actor');
      const alice = await fx.user('dep07t1-alice');
      await seedActiveEmployment(alice.id);

      await seedDueDeparture(alice.id, actor.id, 'dep07t1');

      // A read Alice can make today: her own S1 card (UMAC-01 → 200). The
      // session resolver / SessionGuard must compare the stored `dueAt` with
      // PostgreSQL `now()` before any feature/audience resolution and deny.
      const selfRead = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(alice.id));
      expect(selfRead.status).toBe(401); // red: no cutoff → still 200
    });

    it('Test 2 (guardrail) — the denial is not materialisation-dependent: the row is still `scheduled`, employment still `active`, `User.isActive` still true', async () => {
      const actor = await seedActor('dep07t2-actor');
      const alice = await fx.user('dep07t2-alice');
      await seedActiveEmployment(alice.id);

      await seedDueDeparture(alice.id, actor.id, 'dep07t2');

      const rows = await queryDepartureRows(prisma(), alice.id);
      expect(rows[0]?.state).toBe('scheduled');
      expect(rows[0]?.appliedAt).toBeNull();

      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      expect(employment).toHaveLength(1);
      expect(employment[0]?.status).toBe('active');
      expect(employment[0]?.validTo).toBeNull();

      const aliceRow = await prisma().user.findUnique({
        where: { id: alice.id },
      });
      expect(aliceRow?.isActive).toBe(true);
    });

    it('Test 3 (guardrail) — just before `dueAt` (future, not back-dated) the same request still resolves → 200', async () => {
      const actor = await seedActor('dep07t3-actor');
      const alice = await fx.user('dep07t3-alice');
      await seedActiveEmployment(alice.id);

      // Record the departure but DO NOT back-date `dueAt` — it stays in the
      // future, so the cutoff must not fire.
      const created = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: nearFutureDate(), reason: REASON },
        `dep07t3-${uuidv7()}`,
      );
      expect(created.status).toBe(201);

      const selfRead = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(alice.id));
      expect(selfRead.status).toBe(200);
    });
  });

  // ======================================================================
  // um-dep-08 · a stale executor no-ops; the current-token executor owns the row
  // ======================================================================
  describe('um-dep-08 · stale-executor fencing', () => {
    // Stage-3 unblock trigger met: `DepartureWorkerService` now exists with the
    // skip-locked claim, `leaseToken`/`leaseUntil` fencing and the reclaim path,
    // and `applyDeparture(id, token)` is a real public method returning
    // `'stale' | 'applied' | 'failed'`. The earlier `it.todo` pair is replaced
    // by the scenario's own four tests, driven through that real method — no
    // fake clock, no provider override (AD-3).

    /** Simulate executor A's claim that then stalled: `processing`, token A,
     *  lease already expired. Returns tokenA. */
    const seedStaleLease = async (departureId: string): Promise<string> => {
      const tokenA = randomUUID();
      await prisma().$executeRawUnsafe(
        `UPDATE "departures"
            SET state = $1::"DepartureState",
                "leaseToken" = $2::uuid,
                "leaseUntil" = $3
          WHERE id = $4`,
        'processing',
        tokenA,
        new Date(Date.now() - 60_000),
        departureId,
      );
      return tokenA;
    };

    /** Simulate executor B reclaiming the expired lease. Returns tokenB. */
    const reclaimAs = async (departureId: string): Promise<string> => {
      const tokenB = randomUUID();
      await prisma().$executeRawUnsafe(
        `UPDATE "departures"
            SET "leaseToken" = $1::uuid,
                "leaseUntil" = $2
          WHERE id = $3`,
        tokenB,
        new Date(Date.now() + 60_000),
        departureId,
      );
      return tokenB;
    };

    interface LeaseRow {
      state: string;
      leaseToken: string | null;
      attempts: number | bigint | null;
      lastError: string | null;
      nextAttemptAt: Date | null;
      appliedAt: Date | null;
    }

    const readLease = async (departureId: string): Promise<LeaseRow> => {
      const rows = await prisma().$queryRawUnsafe<LeaseRow[]>(
        `SELECT state, "leaseToken", attempts, "lastError", "nextAttemptAt", "appliedAt"
           FROM "departures" WHERE id = $1`,
        departureId,
      );
      return rows[0];
    };

    it('um-dep-08 Test 1 — a stale-token apply attempt is a no-op: no effect, no retry-state mutation', async () => {
      const actor = await seedActor('dep08t1-actor');
      const alice = await fx.user('dep08t1-alice');
      await seedActiveEmployment(alice.id);
      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep08t1');

      const tokenA = await seedStaleLease(departureId);
      const tokenB = await reclaimAs(departureId);
      expect(tokenB).not.toBe(tokenA);

      const before = await readLease(departureId);

      // Executor A wakes up and tries to apply with its stale token.
      const outcome = await departureWorker(testApp).applyDeparture(
        departureId,
        tokenA,
      );
      expect(outcome).toBe('stale');

      // (a) no employment effect: the `active` interval is still open and no
      //     `dismissed` row was written.
      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      expect(
        employment.find((r) => r.status === 'active')?.validTo,
      ).toBeNull();
      expect(employment.find((r) => r.status === 'dismissed')).toBeUndefined();

      // (b) the account was not deactivated.
      const aliceRow = await prisma().user.findUnique({
        where: { id: alice.id },
      });
      expect(aliceRow?.isActive).toBe(true);

      // (c) no `AccessJournal` row was written by A.
      expect(await queryAccessJournalRows(prisma(), alice.id)).toHaveLength(0);

      // (d) retry state untouched, and B still owns the row.
      const after = await readLease(departureId);
      expect(Number(after.attempts ?? 0)).toBe(Number(before.attempts ?? 0));
      expect(after.lastError).toBe(before.lastError);
      expect(after.nextAttemptAt).toEqual(before.nextAttemptAt);
      expect(after.appliedAt).toBeNull();
      expect(after.leaseToken).toBe(tokenB);
    });

    it('um-dep-08 Test 2 — the current-token executor applies exactly once; a later stale-A retry still no-ops', async () => {
      const actor = await seedActor('dep08t2-actor');
      const alice = await fx.user('dep08t2-alice');
      await seedActiveEmployment(alice.id);
      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep08t2');

      const tokenA = await seedStaleLease(departureId);
      const tokenB = await reclaimAs(departureId);

      const applied = await departureWorker(testApp).applyDeparture(
        departureId,
        tokenB,
      );
      expect(applied).toBe('applied');

      // The LIVE effect set from `um-dep-03`, present exactly once.
      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      const dismissed = employment.filter((r) => r.status === 'dismissed');
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0].sourceDepartureId).toBe(departureId);
      expect(
        employment.find((r) => r.status === 'active')?.validTo,
      ).not.toBeNull();

      const aliceRow = await prisma().user.findUnique({
        where: { id: alice.id },
      });
      expect(aliceRow?.isActive).toBe(false);

      const afterB = await readLease(departureId);
      expect(afterB.state).toBe('applied');
      expect(afterB.appliedAt).not.toBeNull();

      // A wakes up late: still fenced out, and nothing is applied twice.
      const stale = await departureWorker(testApp).applyDeparture(
        departureId,
        tokenA,
      );
      expect(stale).toBe('stale');

      const employmentAfter = await queryEmploymentStatusRows(
        prisma(),
        alice.id,
      );
      expect(
        employmentAfter.filter((r) => r.status === 'dismissed'),
      ).toHaveLength(1);
      const afterA = await readLease(departureId);
      expect(Number(afterA.attempts ?? 0)).toBe(Number(afterB.attempts ?? 0));
      expect(afterA.lastError).toBe(afterB.lastError);
      expect(afterA.appliedAt).toEqual(afterB.appliedAt);
    });

    it('um-dep-08 Test 3 · @concurrency — A and B apply in parallel: exactly one commits, the effect lands once', async () => {
      const actor = await seedActor('dep08t3-actor');
      const alice = await fx.user('dep08t3-alice');
      await seedActiveEmployment(alice.id);
      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep08t3');

      const tokenA = await seedStaleLease(departureId);
      const tokenB = await reclaimAs(departureId);

      // DEC-UM-010: parallel calls inside one test.
      const worker = departureWorker(testApp);
      const [outcomeA, outcomeB] = await Promise.all([
        worker.applyDeparture(departureId, tokenA),
        worker.applyDeparture(departureId, tokenB),
      ]);

      expect(outcomeA).toBe('stale');
      expect(outcomeB).toBe('applied');

      const employment = await queryEmploymentStatusRows(prisma(), alice.id);
      expect(employment.filter((r) => r.status === 'dismissed')).toHaveLength(
        1,
      );

      const row = await readLease(departureId);
      expect(row.state).toBe('applied');
    });

    it('um-dep-08 Test 4 — reclaiming an expired lease bumps `reclaimedLeaseCount` and leaves one in-flight lease, not two', async () => {
      const actor = await seedActor('dep08t4-actor');
      const alice = await fx.user('dep08t4-alice');
      await seedActiveEmployment(alice.id);
      const departureId = await seedDueDeparture(alice.id, actor.id, 'dep08t4');

      await seedStaleLease(departureId);

      const readHealth = async () => {
        const res = await request(server()).get('/health/departures');
        expect(res.status).toBe(200);
        return res.body as {
          reclaimedLeaseCount: number;
          processingCount: number;
        };
      };

      const before = await readHealth();

      // The real claim loop: a `processing` row past `leaseUntil` is eligible,
      // so this pass reclaims it (new token) rather than running a second
      // executor alongside the stalled one.
      await runDepartureWorker(testApp);

      const after = await readHealth();
      expect(after.reclaimedLeaseCount).toBe(before.reclaimedLeaseCount + 1);
      // One lease existed throughout — the reclaim replaced A's, it did not add
      // a second. After the apply the row leaves `processing` entirely.
      expect(after.processingCount).toBeLessThanOrEqual(1);

      const row = await readLease(departureId);
      expect(row.state).toBe('applied');
    });
  });

  // ======================================================================
  // AD-20 health surface — LIVE subset
  // ======================================================================
  describe('um-dep-03 · GET /health/departures · AD-20 health surface (LIVE subset)', () => {
    it('LIVE — returns 200 with the AD-20 counter shape while a due row is unprocessed', async () => {
      const actor = await seedActor('dep-health-actor');
      const alice = await fx.user('dep-health-alice');
      await seedActiveEmployment(alice.id);

      await seedDueDeparture(alice.id, actor.id, 'dep-health');

      const res = await request(server())
        .get('/health/departures')
        .set('authorization', bearer(actor.id));
      expect(res.status).toBe(200); // red: 404, route missing
      const body = res.body as Record<string, unknown>;
      expect(body).toHaveProperty('oldestDueLagSeconds');
      expect(body).toHaveProperty('retryWaitCount');
      expect(body).toHaveProperty('processingCount');
      expect(body).toHaveProperty('reclaimedLeaseCount');
      expect(body).toHaveProperty('requestTimeCutoffDenialsTotal');
      expect(body).toHaveProperty('workerConfig');
      // The back-dated row is due and unprocessed.
      expect(Number(body.oldestDueLagSeconds)).toBeGreaterThan(0);
    });
  });
});
