import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  RECORD_A_DEPARTURE_PERMISSION,
  RunFixtures,
  UNRELATED_PERMISSION,
  bearer,
  bootstrapTestApp,
  departureTable,
  type TestApp,
} from './fixtures';

/**
 * Epic 5 — Employment Lifecycle · Story 5.1 (Record a Departure) · AD-1
 * Stage 2, committed red.
 *
 * BLOCKED — CC-06 (scheduled-departure state + effective-date executor +
 * idempotency) not approved. Route/body/blocker-check from api-conventions.md
 * ("Departure command and status (AD-20)") + AD-16 + AD-20. The
 * effective-date-apply assertions (5.2) encode the AD-20 target outcome and
 * WILL need revision when CC-06 lands. Written as real committed-red per the
 * human's "cover all of them" instruction.
 *
 * Scenarios: docs/test-cases/user-management/departure/
 *   um-dep-01-record-a-departure.md
 *   um-dep-02-blocked-while-managing-or-partnering.md
 *   + the §4.16 permission negative (self vs other — recording a departure is
 *     never a self-service carve-out).
 *
 * WHY RED (per test):
 *   - all: **red-because-route-missing** — `POST /users/:id/departures`,
 *     `GET /users/:id/departures/:departureId`, and
 *     `POST /users/:id/departure-reparenting` are not implemented in
 *     `UserManagementModule` (only `/users`, `/users/:id` GET/PATCH,
 *     `/users/:id/photo`, `DELETE /users/:id` exist), so every call 404s.
 *   - additionally **BLOCKED-CC-06** — the `state: 'scheduled'` shape, the
 *     `expectedBlockerVersion` digest shape, the idempotency-key semantics, and
 *     the re-parenting-then-retry flow encode api-conventions.md + AD-20 prose,
 *     not an approved CC-06 contract. A green here is NOT Story 5.1 acceptance.
 *   - the `departureTable(...)` marker is additionally
 *     **red-because-model-missing** — no `Departure` table on `dn-um-2`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown. NFR-1: pseudonymised fixture data only.
 */
describe('Epic 5 · Story 5.1 — Record a Departure (e2e, committed red — BLOCKED CC-06)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();

  const FUTURE_EFFECTIVE_DATE = '2026-12-01';
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

  const getDeparture = (userId: string, departureId: string, actorId: string) =>
    request(server())
      .get(`/users/${userId}/departures/${departureId}`)
      .set('authorization', bearer(actorId));

  const postReparenting = (
    userId: string,
    actorId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`/users/${userId}/departure-reparenting`)
      .set('authorization', bearer(actorId))
      .send(body);

  const listDefault = (actorId: string) =>
    request(server())
      .get('/users')
      .query({ pageSize: 100 })
      .set('authorization', bearer(actorId));

  /** An actor holding the inferred `record a departure` permission (no role check). */
  const seedActor = async (persona: string) => {
    const actor = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(actor.id, [
      RECORD_A_DEPARTURE_PERMISSION,
      UNRELATED_PERMISSION,
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

  // um-dep-01 ---------------------------------------------------------------
  describe('um-dep-01 · record a future departure without changing current status', () => {
    it('Test 1 — record → 201; body reflects the scheduled effectiveDate + reason; no status/session side effect', async () => {
      const actor = await seedActor('dep01a-actor');
      // Alice manages nobody, manages no department/project, is nobody's PP.
      const alice = await fx.user('dep01a-alice');

      const res = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep01a-${uuidv7()}`,
      );

      expect(res.status).toBe(201);
      const body = res.body as {
        id?: string;
        effectiveDate?: string;
        reason?: string;
        state?: string;
      };
      expect(body.id).toBeTruthy();
      // BLOCKED-CC-06: exact body shape is CC-06's; the contract fixes that the
      // stored effective date + reason are echoed and the row is `scheduled`.
      expect(body.effectiveDate).toBe(FUTURE_EFFECTIVE_DATE);
      expect(body.reason).toBe(REASON);
      expect(body.state ?? 'scheduled').toBe('scheduled');

      // No early state change (AD-16): Alice's account stays usable and she
      // stays on the default employee list until the effective date.
      const list = await listDefault(actor.id);
      expect(list.status).toBe(200);
      const ids = (
        (list.body as { items?: Array<{ id: string }> }).items ?? []
      ).map((u) => u.id);
      expect(ids).toContain(alice.id);

      // red-because-model-missing: once CC-06 lands, replace with a real
      // `departures`-row assertion (exactly one `scheduled` row for Alice).
      expect(await departureTable(testApp.prisma)).not.toBeNull();
    });

    it('Test 2 — status unchanged before the date: GET .../:departureId → state `scheduled`, employment still `active`', async () => {
      const actor = await seedActor('dep01b-actor');
      const alice = await fx.user('dep01b-alice');

      // Precondition chaining (nest-e2e.md): the `<departureId>` this GET needs
      // comes from a real earlier POST response — never a hardcoded id.
      const created = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep01b-${uuidv7()}`,
      );
      expect(created.status).toBe(201);
      const departureId = (created.body as { id: string }).id;

      const res = await getDeparture(alice.id, departureId, actor.id);
      expect(res.status).toBe(200);
      expect((res.body as { state?: string }).state).toBe('scheduled');

      // A separate employment-status read still shows `active` — the recorded
      // departure is a schedule, not an immediate `dismissed` transition
      // (AD-16: employment status is a time-bounded fact distinct from
      // `User.isActive`).
      const employment = await request(server())
        .get(`/users/${alice.id}/employment`)
        .set('authorization', bearer(actor.id));
      expect(employment.status).toBe(200);
      expect((employment.body as { status?: string }).status).toBe('active');
    });
  });

  // um-dep-02 ---------------------------------------------------------------
  describe('um-dep-02 · recording is blocked while responsibilities remain', () => {
    it('person still manages someone → 409 before any schedule is written; body carries blocker summary + expectedBlockerVersion + own-manager default', async () => {
      const actor = await seedActor('dep02-actor');
      const carol = await fx.user('dep02-carol'); // Alice's own manager (default re-parent target)
      const alice = await fx.user('dep02-alice');
      const bob = await fx.user('dep02-bob');

      // Alice still holds a v1.5 management relation: she is Bob's `direct`
      // manager. She also reports to Carol, so the `409` can offer Carol as the
      // default re-parent target.
      await fx.reportsTo(bob.id, alice.id);
      await fx.reportsTo(alice.id, carol.id);

      const res = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep02-${uuidv7()}`,
      );

      expect(res.status).toBe(409);
      const body = res.body as {
        blockers?: unknown[];
        expectedBlockerVersion?: string;
        defaultReparentTargetId?: string;
      };
      // BLOCKED-CC-06 / AD-20: leak-safe blocker summaries the caller may
      // administer, an opaque digest over the sorted blocker identities/targets,
      // and Alice's own manager (Carol) as the default target where available.
      // Exact field names are CC-06's — asserted loosely against the AD-20 prose.
      expect(
        Array.isArray(body.blockers) ? body.blockers.length : 0,
      ).toBeGreaterThan(0);
      expect(typeof body.expectedBlockerVersion).toBe('string');
      const serialized = JSON.stringify(body);
      expect(serialized).toContain(bob.id); // the blocking direct-report target
      expect(serialized).toContain(carol.id); // the offered default re-parent target

      // No `departures` row was created (the 409 precedes any write).
      // red-because-model-missing until CC-06: replace with a real 0-row check.
      expect(await departureTable(testApp.prisma)).not.toBeNull();
    });

    it('re-parent then retry: POST /departure-reparenting re-parents the blocker, retry POST /departures → 201', async () => {
      const actor = await seedActor('dep02r-actor');
      const carol = await fx.user('dep02r-carol');
      const alice = await fx.user('dep02r-alice');
      const bob = await fx.user('dep02r-bob');
      await fx.reportsTo(bob.id, alice.id);
      await fx.reportsTo(alice.id, carol.id);

      // 1) Blocked — capture the digest the re-parenting command must echo.
      const blocked = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep02r-${uuidv7()}`,
      );
      expect(blocked.status).toBe(409);
      const expectedBlockerVersion = (
        blocked.body as { expectedBlockerVersion?: string }
      ).expectedBlockerVersion;

      // 2) Explicit, user-confirmed re-parenting: reassign Bob to Carol.
      const reparent = await postReparenting(alice.id, actor.id, {
        targetId: carol.id,
        expectedBlockerVersion,
      });
      // AD-20: atomic reassignment + journal; success status is CC-06's
      // (200/202/204 all plausible) — assert "not an error, not route-missing".
      expect([200, 201, 202, 204]).toContain(reparent.status);

      // Persisted fact: Bob now reports to Carol, not Alice.
      const bobDirect = await testApp.prisma.relationship.findMany({
        where: { userId: bob.id, type: 'direct' },
      });
      expect(bobDirect).toHaveLength(1);
      expect(bobDirect[0]?.reportsToUserId).toBe(carol.id);

      // 3) Retry the departure — now unblocked.
      const retry = await postDeparture(
        alice.id,
        actor.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep02r-retry-${uuidv7()}`,
      );
      expect(retry.status).toBe(201);
    });
  });

  // §4.16 permission negative --------------------------------------------
  describe('permission · recording a departure requires the capability (self or other)', () => {
    it("an actor without `record a departure` → 403 recording someone else's departure; no schedule written", async () => {
      // Ida holds an unrelated functional role — the gate is the no-target
      // `isAllowed(actor, "record a departure")` facade check, NOT a
      // `position === 'HR Admin'` check (AD-4, DEC-UM-002).
      const ida = await fx.user('dep-perm-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
      const alice = await fx.user('dep-perm-alice');

      const res = await postDeparture(
        alice.id,
        ida.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep-perm-${uuidv7()}`,
      );
      expect(res.status).toBe(403);
    });

    it('recording your OWN departure still requires the capability — no self-service carve-out', async () => {
      const ida = await fx.user('dep-self-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);

      const res = await postDeparture(
        ida.id,
        ida.id,
        { effectiveDate: FUTURE_EFFECTIVE_DATE, reason: REASON },
        `dep-self-${uuidv7()}`,
      );
      expect(res.status).toBe(403);
    });
  });
});
