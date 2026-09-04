import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  cleanupAccessJournal,
  queryAccessJournalRowsByKind,
} from '../epic-4/fixtures';
import {
  LIST_USERS_PERMISSION,
  ORG_RELATIONSHIPS_WRITE_PERMISSION,
  RECORD_A_DEPARTURE_PERMISSION,
  RunFixtures,
  UNRELATED_PERMISSION,
  bearer,
  bootstrapTestApp,
  cleanupDepartures,
  queryDepartureRows,
  type TestApp,
} from './fixtures';

/**
 * Epic 5 — Employment Lifecycle · Story 5.1 (Record a Departure) · AD-1
 * Stage 2, committed red.
 *
 * Reconciled 2026-09-03 to the 2026-09-02 architecture ratification: the
 * `Departure` aggregate schema is RATIFIED (`database-schema.md` §Departure,
 * AD-20) and CC-06 is DESIGN APPROVED. The earlier "BLOCKED — CC-06; scenario
 * prose only" framing is removed — recording a departure, the blocker check +
 * `409` body, `POST /users/:id/departure-reparenting`, and the idempotency
 * semantics are all first-class Stage-2 assertions here. What stays deferred is
 * Story 5.2's effective-date executor/worker (`apply-departure.e2e-spec.ts`,
 * still BLOCKED) and the cross-context `applyDepartureEffects` — neither is
 * exercised in this file.
 *
 * Scenarios: docs/test-cases/user-management/departure/
 *   um-dep-01-record-a-departure.md              (record + GET + no early status change)
 *   um-dep-02-blocked-while-managing-or-partnering.md  (blocker check + 409 body; T4 = it.todo)
 *   um-dep-05-departure-reparenting-and-retry.md  (POST /departure-reparenting, then record)
 *   um-dep-06-idempotent-record.md               (Idempotency-Key semantics + authz)
 *
 * WHY RED (every failing assertion), all for the SAME two reasons:
 *   - **red-because-route-missing** — `UserManagementModule` implements only
 *     `/users`, `/users/:id` GET/PATCH, `/users/:id/photo`, `DELETE /users/:id`,
 *     the Epic 3/4 relationship + event routes. `POST /users/:id/departures`,
 *     `GET /users/:id/departures/:departureId` and
 *     `POST /users/:id/departure-reparenting` do not exist → every call 404s, so
 *     `expect(...).toBe(201 | 200 | 409 | 403)` is red.
 *   - **red-because-model-missing** — `schema.prisma` has no `Departure` model,
 *     so `queryDepartureRows(...)` returns `[]` and every "exactly one
 *     `Departure` row / `state: 'scheduled'` / non-null `dueAt`" assertion is
 *     red (expected 1, got 0). The `AccessJournal` table is likewise absent
 *     (Story 4.1 not landed), so the re-parent journal assertions are red too.
 *   Guardrail assertions that are GREEN today and must STAY green through Stage
 *   3 are flagged inline ("guardrail"): zero `Departure` rows after a `409` /
 *   `403`, current `EmploymentStatus` still `active` after a record, the subject
 *   still on the active default list, the subject's session still resolving.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown (departures → journal → employment_status →
 * department policies → relationships/policies → users). NFR-1: pseudonymised
 * fixture data only. Blocker preconditions are REAL `Relationship` / `Policies`
 * / `UserPolicies` rows (nest-e2e.md — preconditions must be real).
 */
describe('Epic 5 · Story 5.1 — Record a Departure (e2e, committed red)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;
  let deptIds: string[];

  const server = () => testApp.app.getHttpServer();
  const prisma = () => testApp.prisma;

  const FUTURE_EFFECTIVE_DATE = '2026-12-01';
  const OTHER_FUTURE_DATE = '2027-01-15';
  const REASON = 'relocation';

  const WORKER_INTERNALS = [
    'attempts',
    'leaseToken',
    'leaseUntil',
    'lastError',
    'requestHash',
    'idempotencyKey',
    'nextAttemptAt',
  ] as const;

  const recordBody = (effectiveDate = FUTURE_EFFECTIVE_DATE) => ({
    effectiveDate,
    reason: REASON,
  });

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

  /** The active default list, narrowed to one run-scoped persona by workEmail. */
  const listContains = async (
    actorId: string,
    workEmail: string,
  ): Promise<{ status: number; hasEmail: boolean }> => {
    const res = await request(server())
      .get('/users')
      .query({ workEmail, pageSize: 50 })
      .set('authorization', bearer(actorId));
    const body = res.body as Record<string, unknown>;
    const rows = (body.data ?? body.items ?? body.results ?? []) as Array<{
      workEmail?: string;
    }>;
    return {
      status: res.status,
      hasEmail: rows.some((u) => u.workEmail === workEmail),
    };
  };

  const blockerKinds = (body: unknown): string[] => {
    const blockers = (body as { blockers?: Array<{ kind?: string }> }).blockers;
    return Array.isArray(blockers)
      ? blockers.map((b) => b.kind ?? '').filter(Boolean)
      : [];
  };

  // --- seeding (direct Prisma — genuine preconditions, no HTTP seam) -------

  /** One FR-granted actor per test (the RunFixtures targetRole-collision bug). */
  const seedActor = async (
    persona: string,
    keys: readonly string[] = [
      RECORD_A_DEPARTURE_PERMISSION,
      UNRELATED_PERMISSION,
    ],
  ) => {
    const actor = await fx.user(persona, { position: 'HR Admin' });
    const grant = await fx.grantFunctionalRole(actor.id, keys);
    return { actor, grant };
  };

  const seedDepartment = async (label: string) => {
    const dept = await prisma().department.create({
      data: { name: `${fx.runId}-${label}`, externalId: null },
    });
    deptIds.push(dept.id);
    return dept;
  };

  /** The department-manager fact: an AR `Policies` row + a `UserPolicies` link. */
  const seedDeptManager = async (departmentId: string, managerId: string) => {
    const policy = await prisma().policy.create({
      data: {
        operator: '==',
        targetType: 'department',
        targetId: departmentId,
        targetRole: 'unit-manager',
        type: 'AR',
        managedBy: 'admin',
      },
    });
    await prisma().userPolicy.create({
      data: { userId: managerId, policyId: policy.id },
    });
    return policy;
  };

  const seedActiveEmployment = (userId: string) =>
    prisma().employmentStatus.create({
      data: { userId, status: 'active', validFrom: new Date('2020-01-01') },
    });

  const currentEmployment = (userId: string) =>
    prisma().employmentStatus.findMany({
      where: { userId, validTo: null },
    });

  const unitManagerLinks = (departmentId: string) =>
    prisma().userPolicy.findMany({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: departmentId,
          targetRole: 'unit-manager',
        },
      },
    });

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
    deptIds = [];
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
      () =>
        testApp.prisma.userPolicy.deleteMany({
          where: { policy: { targetId: { in: deptIds } } },
        }),
      () =>
        testApp.prisma.policy.deleteMany({
          where: { targetId: { in: deptIds } },
        }),
      () =>
        testApp.prisma.department.deleteMany({
          where: { id: { in: deptIds } },
        }),
      () => fx.cleanup(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn('[epic-5 · story-5.1] teardown step failed', error);
      }
    }
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ======================================================================
  // um-dep-01 · record a future departure without changing current status
  // ======================================================================
  describe('um-dep-01 · record → 201, scheduled row, no early status change', () => {
    it('Test 1 — record → 201; full projection body; one `scheduled` row with resolved dueAt/effectiveTimeZone; no worker internals', async () => {
      const { actor } = await seedActor('dep01a-actor');
      // Alice manages nobody, manages no department, is nobody's PP.
      const alice = await fx.user('dep01a-alice');
      await seedActiveEmployment(alice.id);

      const res = await postDeparture(
        alice.id,
        actor.id,
        recordBody(),
        `dep01a-${uuidv7()}`,
      );

      expect(res.status).toBe(201);
      const body = res.body as Record<string, unknown>;
      expect(body).toMatchObject({
        userId: alice.id,
        state: 'scheduled',
        effectiveDate: FUTURE_EFFECTIVE_DATE,
        reason: REASON,
      });
      expect(typeof body.departureId).toBe('string');
      expect(typeof body.effectiveTimeZone).toBe('string');
      expect(body.dueAt).toBeTruthy();
      expect(body.createdAt).toBeTruthy();
      for (const leak of WORKER_INTERNALS) {
        expect(body).not.toHaveProperty(leak);
      }

      // Exactly one Departure row, scheduled, dueAt + effectiveTimeZone
      // resolved once, not yet applied (exact dueAt instant is Stage 3's —
      // BUSINESS_TIME_ZONE-dependent).
      const rows = await queryDepartureRows(testApp.prisma, alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('scheduled');
      expect(rows[0]?.effectiveTimeZone).toBeTruthy();
      expect(rows[0]?.dueAt).not.toBeNull();
      expect(rows[0]?.appliedAt).toBeNull();
      expect(rows[0]?.attempts).toBe(0);

      // Guardrail — recording does NOT change the current employment fact.
      const employment = await currentEmployment(alice.id);
      expect(employment).toHaveLength(1);
      expect(employment[0]?.status).toBe('active');

      // Guardrail — Alice still on the active default list.
      const list = await listContains(actor.id, alice.workEmail);
      expect(list.status).toBe(200);
      expect(list.hasEmail).toBe(true);

      // Guardrail — Alice's own session still resolves.
      const selfRead = await request(server())
        .get(`/users/${alice.id}`)
        .set('authorization', bearer(alice.id));
      expect(selfRead.status).toBe(200);
    });

    it('Test 2 — GET .../:departureId → 200, same projection, `state: scheduled`, no worker internals', async () => {
      const { actor } = await seedActor('dep01b-actor');
      const alice = await fx.user('dep01b-alice');

      // Precondition chaining (nest-e2e.md): the <departureId> comes from a real
      // earlier POST response — never a hardcoded id.
      const created = await postDeparture(
        alice.id,
        actor.id,
        recordBody(),
        `dep01b-${uuidv7()}`,
      );
      expect(created.status).toBe(201);
      const departureId = (created.body as { departureId?: string })
        .departureId;

      const res = await getDeparture(
        alice.id,
        departureId ?? 'no-departure-id',
        actor.id,
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body).toMatchObject({
        departureId,
        userId: alice.id,
        state: 'scheduled',
        effectiveDate: FUTURE_EFFECTIVE_DATE,
        reason: REASON,
      });
      expect(body.dueAt).toBeTruthy();
      for (const leak of WORKER_INTERNALS) {
        expect(body).not.toHaveProperty(leak);
      }
    });
  });

  // ======================================================================
  // um-dep-02 · recording is blocked while responsibilities remain
  // ======================================================================
  describe('um-dep-02 · blocker check runs before any row; 409 with leak-safe body', () => {
    it('Test 1 — blocked as a direct manager → 409 before any row; direct_report blocker + opaque digest + own-manager default', async () => {
      const { actor } = await seedActor('dep02t1-actor');
      const bob = await fx.user('dep02t1-bob');
      const report = await fx.user('dep02t1-report');
      const bobManager = await fx.user('dep02t1-bobmgr');
      await fx.reportsTo(report.id, bob.id); // Bob manages a direct report
      await fx.reportsTo(bob.id, bobManager.id); // Bob's own manager → default target

      const res = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep02t1-${uuidv7()}`,
      );

      expect(res.status).toBe(409);
      const body = res.body as {
        blockers?: unknown[];
        expectedBlockerVersion?: string;
        defaultReparentTargetId?: string;
      };
      expect(blockerKinds(body)).toContain('direct_report');
      expect(JSON.stringify(body)).toContain(report.id);
      expect(typeof body.expectedBlockerVersion).toBe('string');
      expect(body.expectedBlockerVersion ?? '').toMatch(/^v1:.+/);
      expect(body.defaultReparentTargetId).toBe(bobManager.id);

      // Guardrail — the 409 precedes any write; the key is unconsumed.
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(0);
    });

    it('Test 2 — blocked as a department manager → 409; department_manager blocker names the department', async () => {
      const { actor } = await seedActor('dep02t2-actor');
      const bob = await fx.user('dep02t2-bob');
      const dept = await seedDepartment('js');
      await seedDeptManager(dept.id, bob.id); // Bob manages a department

      const res = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep02t2-${uuidv7()}`,
      );

      expect(res.status).toBe(409);
      const body = res.body as { expectedBlockerVersion?: string };
      expect(blockerKinds(body)).toContain('department_manager');
      expect(JSON.stringify(body)).toContain(dept.id);
      expect(body.expectedBlockerVersion ?? '').toMatch(/^v1:.+/);
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(0);
    });

    it('Test 3 — blocked as an assigned People Partner → 409; people_partner blocker names the partnered person', async () => {
      const { actor } = await seedActor('dep02t3-actor');
      const bob = await fx.user('dep02t3-bob');
      const nina = await fx.user('dep02t3-nina');
      await fx.peoplePartnerOf(nina.id, bob.id); // Bob is Nina's PP

      const res = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep02t3-${uuidv7()}`,
      );

      expect(res.status).toBe(409);
      const body = res.body as { expectedBlockerVersion?: string };
      expect(blockerKinds(body)).toContain('people_partner');
      expect(JSON.stringify(body)).toContain(nina.id);
      expect(body.expectedBlockerVersion ?? '').toMatch(/^v1:.+/);
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(0);
    });

    // T4 — external timetracker-derived PM/DM blocker is a read-only
    // remediation item (never a platform shadow policy). No sync seam exists to
    // produce the signal (Story 5.2 cross-context deferral) → it.todo.
    it.todo(
      'Test 4 — external PM/DM blocker is a read-only external-remediation item (needs the timetracker sync seam)',
    );

    it('Test 5 — multiple blocker kinds at once → one 409, all three platform kinds, a single digest, still zero rows', async () => {
      const { actor } = await seedActor('dep02t5-actor');
      const bob = await fx.user('dep02t5-bob');
      const report = await fx.user('dep02t5-report');
      const nina = await fx.user('dep02t5-nina');
      const dept = await seedDepartment('js');
      await fx.reportsTo(report.id, bob.id);
      await seedDeptManager(dept.id, bob.id);
      await fx.peoplePartnerOf(nina.id, bob.id);

      const res = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep02t5-${uuidv7()}`,
      );

      expect(res.status).toBe(409);
      const kinds = blockerKinds(res.body);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'direct_report',
          'department_manager',
          'people_partner',
        ]),
      );
      expect(
        (res.body as { expectedBlockerVersion?: string })
          .expectedBlockerVersion ?? '',
      ).toMatch(/^v1:.+/);
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(0);
    });
  });

  // ======================================================================
  // um-dep-05 · re-parenting clears the platform blockers, then record succeeds
  // ======================================================================
  describe('um-dep-05 · POST /users/:id/departure-reparenting, then record', () => {
    const seedReparentActor = (persona: string) =>
      seedActor(persona, [
        RECORD_A_DEPARTURE_PERMISSION,
        ORG_RELATIONSHIPS_WRITE_PERMISSION,
        LIST_USERS_PERMISSION,
      ]);

    it('Test 1 — re-parent atomically reassigns the 3 platform blockers + one AccessJournal row per kind; writes NO Departure row', async () => {
      const { actor } = await seedReparentActor('dep05t1-actor');
      const bob = await fx.user('dep05t1-bob');
      const alice = await fx.user('dep05t1-alice');
      const nina = await fx.user('dep05t1-nina');
      const colin = await fx.user('dep05t1-colin'); // unrelated re-parent target
      const dept = await seedDepartment('js');
      await fx.reportsTo(alice.id, bob.id);
      await seedDeptManager(dept.id, bob.id);
      await fx.peoplePartnerOf(nina.id, bob.id);

      // 1) Blocked — capture the digest the re-parent command must echo.
      const blocked = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep05t1-${uuidv7()}`,
      );
      expect(blocked.status).toBe(409);
      const expectedBlockerVersion = (
        blocked.body as { expectedBlockerVersion?: string }
      ).expectedBlockerVersion;

      // 2) Explicit user-confirmed re-parenting to Colin.
      const reparent = await postReparenting(bob.id, actor.id, {
        targetId: colin.id,
        expectedBlockerVersion: expectedBlockerVersion ?? 'v1:absent',
      });
      expect(reparent.status).toBe(200);
      expect(reparent.body).toMatchObject({
        reassigned: {
          directReports: 1,
          departmentManager: true,
          peoplePartnerAssignments: 1,
        },
        remainingExternalBlockers: 0,
      });

      // 3) Persisted reassignments — every platform blocker now points at Colin.
      const aliceDirect = await prisma().relationship.findMany({
        where: { userId: alice.id, type: 'direct' },
      });
      expect(aliceDirect).toHaveLength(1);
      expect(aliceDirect[0]?.reportsToUserId).toBe(colin.id);

      const ninaPp = await prisma().relationship.findMany({
        where: { userId: nina.id, type: 'people_partner' },
      });
      expect(ninaPp).toHaveLength(1);
      expect(ninaPp[0]?.reportsToUserId).toBe(colin.id);

      const deptLinks = await unitManagerLinks(dept.id);
      expect(deptLinks).toHaveLength(1);
      expect(deptLinks[0]?.userId).toBe(colin.id);

      // 4) One AccessJournal row per reassignment kind (before:Bob → after:Colin).
      for (const kind of [
        'manager',
        'department_manager',
        'people_partner',
      ] as const) {
        const rows = (
          await queryAccessJournalRowsByKind(testApp.prisma, kind)
        ).filter((r) => JSON.stringify(r).includes(colin.id));
        expect(rows.length).toBeGreaterThanOrEqual(1);
      }

      // 5) Guardrail — the re-parent command records NO departure.
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(0);
    });

    it('Test 2 — stale expectedBlockerVersion → 409, nothing reassigned, transaction rolled back whole', async () => {
      const { actor } = await seedReparentActor('dep05t2-actor');
      const bob = await fx.user('dep05t2-bob');
      const alice = await fx.user('dep05t2-alice');
      const colin = await fx.user('dep05t2-colin');
      await fx.reportsTo(alice.id, bob.id);

      const reparent = await postReparenting(bob.id, actor.id, {
        targetId: colin.id,
        expectedBlockerVersion: 'v1:stale-digest-that-does-not-match',
      });
      expect(reparent.status).toBe(409);

      // Guardrail — Alice still reports to Bob; no reassignment happened.
      const aliceDirect = await prisma().relationship.findMany({
        where: { userId: alice.id, type: 'direct' },
      });
      expect(aliceDirect).toHaveLength(1);
      expect(aliceDirect[0]?.reportsToUserId).toBe(bob.id);
    });

    it('Test 3 — after a successful re-parent, the follow-up POST .../departures → 201', async () => {
      const { actor } = await seedReparentActor('dep05t3-actor');
      const bob = await fx.user('dep05t3-bob');
      const alice = await fx.user('dep05t3-alice');
      const colin = await fx.user('dep05t3-colin');
      await fx.reportsTo(alice.id, bob.id);

      const blocked = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep05t3-blocked-${uuidv7()}`,
      );
      expect(blocked.status).toBe(409);
      const expectedBlockerVersion = (
        blocked.body as { expectedBlockerVersion?: string }
      ).expectedBlockerVersion;

      const reparent = await postReparenting(bob.id, actor.id, {
        targetId: colin.id,
        expectedBlockerVersion: expectedBlockerVersion ?? 'v1:absent',
      });
      expect(reparent.status).toBe(200);

      const retry = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep05t3-retry-${uuidv7()}`,
      );
      expect(retry.status).toBe(201);
      expect(await queryDepartureRows(testApp.prisma, bob.id)).toHaveLength(1);
    });

    it('Test 5 — @concurrency: two identical re-parent calls → at most one 200, edge set applied exactly once', async () => {
      const { actor } = await seedReparentActor('dep05t5-actor');
      const bob = await fx.user('dep05t5-bob');
      const alice = await fx.user('dep05t5-alice');
      const colin = await fx.user('dep05t5-colin');
      await fx.reportsTo(alice.id, bob.id);

      const blocked = await postDeparture(
        bob.id,
        actor.id,
        recordBody(),
        `dep05t5-${uuidv7()}`,
      );
      expect(blocked.status).toBe(409);
      const expectedBlockerVersion =
        (blocked.body as { expectedBlockerVersion?: string })
          .expectedBlockerVersion ?? 'v1:absent';

      const [a, b] = await Promise.all([
        postReparenting(bob.id, actor.id, {
          targetId: colin.id,
          expectedBlockerVersion,
        }),
        postReparenting(bob.id, actor.id, {
          targetId: colin.id,
          expectedBlockerVersion,
        }),
      ]);
      expect(
        [a.status, b.status].filter((s) => s === 200).length,
      ).toBeLessThanOrEqual(1);

      // Convergence: exactly one current direct edge for Alice, pointing at Colin.
      const aliceDirect = await prisma().relationship.findMany({
        where: { userId: alice.id, type: 'direct' },
      });
      expect(aliceDirect).toHaveLength(1);
      expect(aliceDirect[0]?.reportsToUserId).toBe(colin.id);
    });
  });

  // ======================================================================
  // um-dep-06 · recording is idempotent per Idempotency-Key; authz on every path
  // ======================================================================
  describe('um-dep-06 · Idempotency-Key semantics + authorization', () => {
    it('Test 1 — replay: same key + same payload → the original 201, exactly one Departure row', async () => {
      const { actor } = await seedActor('dep06t1-actor');
      const alice = await fx.user('dep06t1-alice');
      const key = `dep06t1-${uuidv7()}`;

      const first = await postDeparture(alice.id, actor.id, recordBody(), key);
      expect(first.status).toBe(201);
      const second = await postDeparture(alice.id, actor.id, recordBody(), key);
      expect(second.status).toBe(201);
      expect((second.body as { departureId?: string }).departureId).toBe(
        (first.body as { departureId?: string }).departureId,
      );
      expect(await queryDepartureRows(testApp.prisma, alice.id)).toHaveLength(
        1,
      );
    });

    it('Test 2 — same key + different effectiveDate → 409, the row is unchanged', async () => {
      const { actor } = await seedActor('dep06t2-actor');
      const alice = await fx.user('dep06t2-alice');
      const key = `dep06t2-${uuidv7()}`;

      const first = await postDeparture(alice.id, actor.id, recordBody(), key);
      expect(first.status).toBe(201);

      const mismatch = await postDeparture(
        alice.id,
        actor.id,
        recordBody(OTHER_FUTURE_DATE),
        key,
      );
      expect(mismatch.status).toBe(409);

      const rows = await queryDepartureRows(testApp.prisma, alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.effectiveDate?.toISOString().slice(0, 10)).toBe(
        FUTURE_EFFECTIVE_DATE,
      );
    });

    it('Test 3 — different key while a non-applied Departure exists → 409 (partial UNIQUE), no second row', async () => {
      const { actor } = await seedActor('dep06t3-actor');
      const alice = await fx.user('dep06t3-alice');

      const first = await postDeparture(
        alice.id,
        actor.id,
        recordBody(),
        `dep06t3-k1-${uuidv7()}`,
      );
      expect(first.status).toBe(201);

      const second = await postDeparture(
        alice.id,
        actor.id,
        recordBody(),
        `dep06t3-k2-${uuidv7()}`,
      );
      expect(second.status).toBe(409);
      expect(await queryDepartureRows(testApp.prisma, alice.id)).toHaveLength(
        1,
      );
    });

    it('Test 4 — actor lacks employee:departure:record → 403 recording someone else; no row, key unconsumed', async () => {
      const ida = await fx.user('dep06t4-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
      const alice = await fx.user('dep06t4-alice');

      const res = await postDeparture(
        alice.id,
        ida.id,
        recordBody(),
        `dep06t4-${uuidv7()}`,
      );
      expect(res.status).toBe(403);
      // Guardrail — no schedule written on the denied path.
      expect(await queryDepartureRows(testApp.prisma, alice.id)).toHaveLength(
        0,
      );
    });

    it('Test 4b — recording your OWN departure still requires the capability (no self-service carve-out)', async () => {
      const ida = await fx.user('dep06t4b-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);

      const res = await postDeparture(
        ida.id,
        ida.id,
        recordBody(),
        `dep06t4b-${uuidv7()}`,
      );
      expect(res.status).toBe(403);
      expect(await queryDepartureRows(testApp.prisma, ida.id)).toHaveLength(0);
    });

    it('Test 5 — replay after losing authorization → 403, and the stored departure is not disclosed', async () => {
      const { actor, grant } = await seedActor('dep06t5-actor');
      const alice = await fx.user('dep06t5-alice');
      const key = `dep06t5-${uuidv7()}`;

      const first = await postDeparture(alice.id, actor.id, recordBody(), key);
      expect(first.status).toBe(201);

      // Revoke the actor's employee:departure:record grant.
      await testApp.prisma.userPolicy.deleteMany({
        where: { userId: actor.id, policyId: grant.policyId },
      });

      const replay = await postDeparture(alice.id, actor.id, recordBody(), key);
      expect(replay.status).toBe(403);
      const serialized = JSON.stringify(replay.body ?? {});
      expect(serialized).not.toContain('scheduled');
      expect(serialized).not.toContain(alice.id);
    });

    it('Test 6 — @concurrency: two identical first-time requests (same key) → one row, both resolve to it', async () => {
      const { actor } = await seedActor('dep06t6-actor');
      const alice = await fx.user('dep06t6-alice');
      const key = `dep06t6-${uuidv7()}`;

      const [a, b] = await Promise.all([
        postDeparture(alice.id, actor.id, recordBody(), key),
        postDeparture(alice.id, actor.id, recordBody(), key),
      ]);

      // Exactly one insert; the other is a replay 201 or a losing 409.
      expect(
        [a.status, b.status].filter((s) => s === 201).length,
      ).toBeGreaterThanOrEqual(1);
      expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(
        true,
      );
      expect(await queryDepartureRows(testApp.prisma, alice.id)).toHaveLength(
        1,
      );
    });
  });
});
