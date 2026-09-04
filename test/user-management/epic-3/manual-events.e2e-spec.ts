import request from 'supertest';
import {
  CAREER_TIMELINE_PERMISSION_KEY,
  RunFixtures,
  type TestApp,
  bearer,
  bootstrapTestApp,
  cleanupUserEvents,
  queryUserEvents,
} from './fixtures';

/**
 * Epic 3 — Story 3.2 (Authorized Actor Manually Adds a Backfill Entry) · AD-1
 * Stage 2, committed red.
 *
 * Contract (source of truth):
 *   docs/test-cases/user-management/career-timeline/README.md — the split-gate
 *   decision table (Dmytro, 2026-09-02).
 *   _bmad-output/implementation-artifacts/user-management/
 *     spec-3-2-authorized-actor-manually-adds-a-backfill-entry.md
 *
 * ── The gate this story ships ──────────────────────────────────────────────
 *
 *  `profile:timeline:write` IS a real functional permission. Story 3.2 seeds it
 *  and grants it to the `hr-admin` role ONLY. The manual-write gate at this
 *  stage is `isAllowed(actor, 'profile:timeline:write')` ALONE — a feature
 *  action, NO `canAccessSection` / data-audience half. HR Admin holds no S9
 *  write audience at all (§2.2 NORMATIVE), so requiring the audience half now
 *  would close the gate to everyone; HR-Admin backfill of the legacy Excel
 *  headcount record is a bulk-migration feature action.
 *
 *  The `GET /users/:id/events` read gate is WIDENED: `canReadTimeline` =
 *  `<S9 read audience>` OR `isAllowed(viewer, 'profile:timeline:write')`
 *  ("edit implies read"), so an HR Admin can read the timeline back.
 *
 *  DEC-UM-001 audience narrowing (assigned PP + direct Unit Manager) is
 *  DEFERRED — not enforced this stage; it reactivates when the
 *  FR-permission-matrix grants `profile:timeline:write` to the PP / Unit-Manager
 *  roles.
 *
 * ── LIVE vs DEFERRED in this file ──────────────────────────────────────────
 *
 *  um-ct-12  LIVE — the one manual-add path Story 3.2 ships (HR Admin). RED
 *            today: `POST /users/:id/events` is not bound (users.controller.ts
 *            has `:id` GET/PATCH/PUT-photo/DELETE, a collection-root
 *            GET/POST-import, and `GET :id/events` — no `POST :id/events`), so
 *            the write 404s instead of 201; and the Story-3.1 read gate is not
 *            widened yet, so an HR-Admin read-back 403s instead of 200.
 *
 *  um-ct-10  LIVE — feature-permission gate alone denies. Bob holds no
 *            `profile:timeline:write`; his relationship to Alice is irrelevant.
 *            RED today: route 404, not the target 403.
 *
 *  um-ct-03 / um-ct-04 / um-ct-09 + the DEC-UM-001 narrowing case  DEFERRED —
 *            `it.todo`. Each title states its unblock trigger. The describe
 *            blocks are kept; the target-end-state bodies are recorded in the
 *            scenario docs, not duplicated here.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. Fixtures seed real `User` + `Relationship` + FR-grant-chain rows
 * and issue `Bearer <token:<seeded-uuid>>`. DEC-UM-010: one worker,
 * run-namespaced data, wrapped scoped teardown (events -> relationships ->
 * policies/permissions -> users).
 */
describe('Epic 3 · Manual backfill — POST /users/:id/events (e2e, committed red)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const postEvent = (
    targetId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(testApp.app.getHttpServer())
      .post(`/users/${targetId}/events`)
      .set('authorization', bearer(viewerId))
      .send(body);

  const getEvents = (targetId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .get(`/users/${targetId}/events`)
      .set('authorization', bearer(viewerId));

  // A Root/HR-Admin persona that holds `profile:timeline:write`. The real
  // `hr-admin` default seed does not carry this key yet (see the `it.todo`
  // below), so grant it explicitly in-test — the test's functional intent is
  // then self-contained and red ONLY on the missing `POST` route / un-widened
  // read gate, never on a missing grant.
  const seedTimelineWriter = async (persona: string) => {
    const actor = await fx.user(persona, { firstName: 'Root' });
    await fx.grantFunctionalRole(actor.id, [CAREER_TIMELINE_PERMISSION_KEY]);
    return actor;
  };

  const BARE_EVENT_KEYS = [
    'createdAt',
    'details',
    'eventDate',
    'id',
    'source',
    'type',
  ];

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

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-12 — HR Admin manually adds a backfill entry — LIVE
  // docs/test-cases/user-management/career-timeline/um-ct-12-hr-admin-manual-add.md
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-12 · HR Admin manually adds a backfill entry [LIVE — the one manual-add path Story 3.2 ships]', () => {
    // Records the seed dependency this suite works around: the shipped gate
    // needs `profile:timeline:write` seeded AND granted to the `hr-admin` role
    // by the kernel/ACM bootstrap. Until then every LIVE test here grants it
    // in-test via `fx.grantFunctionalRole`.
    it.todo(
      'um-ct-12 · the hr-admin role holds profile:timeline:write by default seed — Stage 3 / ACM bootstrap',
    );

    it('um-ct-12 Test 1 · Root POSTs a pre-system grade_change → 201 bare UserEventResponse, source:"manual" server-stamped, row active [RED: no POST /users/:id/events route → 404]', async () => {
      const root = await seedTimelineWriter('ct12t1-root');
      const alice = await fx.user('ct12t1-alice', { firstName: 'Alice' });

      const write = await postEvent(alice.id, root.id, {
        type: 'grade_change',
        eventDate: '2018-09-01',
        details: { grade: 'M2' },
      });

      expect(write.status).toBe(201);
      // Bare resource, NOT the `{ data, canEdit }` envelope (matches how
      // `PATCH /users/:id` returns the bare user).
      expect(Object.keys(write.body as Record<string, unknown>).sort()).toEqual(
        BARE_EVENT_KEYS,
      );
      expect(write.body).toMatchObject({
        type: 'grade_change',
        eventDate: '2018-09-01',
        details: { grade: 'M2' },
        source: 'manual',
      });
      const createdId = (write.body as { id?: string }).id;
      expect(createdId).toEqual(expect.any(String));

      // Row persisted active (`deletedAt` null → returned by queryUserEvents).
      const rows = await queryUserEvents(testApp.prisma, alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: createdId,
        type: 'grade_change',
        source: 'manual',
        deletedAt: null,
      });
    });

    it('um-ct-12 Test 2 · Root reads the timeline back → 200 { data, canEdit:true } incl. the new event (edit implies read); Alice-as-Self → canEdit:false [RED: POST route missing → 404; read gate not widened → Root GET 403]', async () => {
      const root = await seedTimelineWriter('ct12t2-root');
      const alice = await fx.user('ct12t2-alice', { firstName: 'Alice' });

      const write = await postEvent(alice.id, root.id, {
        type: 'grade_change',
        eventDate: '2018-09-01',
        details: { grade: 'M2' },
      });
      expect(write.status).toBe(201);
      const createdId = (write.body as { id?: string }).id;

      // Root has NO S9 read audience over Alice, but holds
      // `profile:timeline:write` → the widened `canReadTimeline` admits him and
      // `canEdit` is `true`.
      const rootRead = await getEvents(alice.id, root.id);
      expect(rootRead.status).toBe(200);
      expect(rootRead.body).toMatchObject({ canEdit: true });
      expect((rootRead.body as { data: unknown[] }).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: createdId, source: 'manual' }),
        ]),
      );

      // Self still reads (S9 `self` audience) but cannot edit — she does not
      // hold `profile:timeline:write`.
      const selfRead = await getEvents(alice.id, alice.id);
      expect(selfRead.status).toBe(200);
      expect(selfRead.body).toMatchObject({ canEdit: false });
      expect((selfRead.body as { data: unknown[] }).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: createdId, source: 'manual' }),
        ]),
      );
    });

    it('um-ct-12 Test 3 · body carrying id/deletedAt/source:"system"/createdBy → still 201; whitelist strips them, server values win [RED: no POST /users/:id/events route → 404]', async () => {
      const root = await seedTimelineWriter('ct12t3-root');
      const alice = await fx.user('ct12t3-alice', { firstName: 'Alice' });

      const suppliedId = '00000000-0000-0000-0000-000000000000';
      const write = await postEvent(alice.id, root.id, {
        type: 'position_change',
        eventDate: '2019-01-01',
        details: {},
        id: suppliedId,
        deletedAt: '2020-01-01T00:00:00Z',
        source: 'system',
        createdBy: alice.id,
      });

      // No 400 — `whitelist` strips unknown/forbidden keys silently, consistent
      // with the rest of UM's DTOs.
      expect(write.status).toBe(201);
      expect((write.body as { id?: string }).id).not.toBe(suppliedId);

      const rows = await queryUserEvents(testApp.prisma, alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).not.toBe(suppliedId);
      expect(rows[0].deletedAt).toBeNull();
      expect(rows[0].source).toBe('manual');
      // `createdBy` = the authenticated actor, server-set (not the body value).
      expect(rows[0].createdBy).toBe(root.id);
    });

    it('um-ct-12 Test 4 · missing / empty `type` → 400, nothing written [RED: no POST /users/:id/events route → 404]', async () => {
      const root = await seedTimelineWriter('ct12t4-root');
      const alice = await fx.user('ct12t4-alice', { firstName: 'Alice' });

      const missing = await postEvent(alice.id, root.id, {
        eventDate: '2018-09-01',
        details: {},
      });
      expect(missing.status).toBe(400);

      const empty = await postEvent(alice.id, root.id, {
        type: '',
        eventDate: '2018-09-01',
        details: {},
      });
      expect(empty.status).toBe(400);

      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });

    it('um-ct-12 Test 5 · invalid `eventDate` ("not-a-date") → 400, nothing written [RED: no POST /users/:id/events route → 404]', async () => {
      const root = await seedTimelineWriter('ct12t5-root');
      const alice = await fx.user('ct12t5-alice', { firstName: 'Alice' });

      const bad = await postEvent(alice.id, root.id, {
        type: 'grade_change',
        eventDate: 'not-a-date',
        details: {},
      });
      expect(bad.status).toBe(400);

      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });

    it('um-ct-12 Test 6 · Ida (unrelated functional permission only) → 403; no Authorization header → 401; nothing written [RED: no POST /users/:id/events route → 404]', async () => {
      const alice = await fx.user('ct12t6-alice', { firstName: 'Alice' });
      const ida = await fx.user('ct12t6-ida', { firstName: 'Ida' });
      // DEC-UM-002 probe: Ida holds a functional permission, just not this one.
      await fx.grantFunctionalRole(ida.id, ['user-management:list']);

      const denied = await postEvent(alice.id, ida.id, {
        type: 'grade_change',
        eventDate: '2018-09-01',
        details: {},
      });
      expect(denied.status).toBe(403);

      const unauth = await request(testApp.app.getHttpServer())
        .post(`/users/${alice.id}/events`)
        .send({ type: 'grade_change', eventDate: '2018-09-01', details: {} });
      expect(unauth.status).toBe(401);

      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-10 — has the S9 write audience but lacks the functional permission
  // docs/test-cases/user-management/career-timeline/um-ct-10-s9-write-without-permission-denied.md
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-10 · direct Unit Manager without `profile:timeline:write` → denied [LIVE]', () => {
    it('um-ct-10 · Bob (Alice’s direct UM, no `profile:timeline:write` grant) POSTs an event → 403, nothing written [RED: no POST /users/:id/events route → 404]', async () => {
      const bob = await fx.user('ct10-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct10-alice', { firstName: 'Alice' });
      // Bob IS Alice's direct Unit Manager — the S9 write audience under the
      // target end-state. Kept to prove the point: at this stage the feature-
      // permission gate alone denies him, so the relationship is irrelevant.
      await fx.reportsTo(alice.id, bob.id);

      const write = await postEvent(alice.id, bob.id, {
        type: 'grade_change',
        eventDate: '2023-01-01',
        details: {},
      });
      expect(write.status).toBe(403);

      // No event written or soft-deleted.
      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEFERRED — `it.todo`. Bodies live in the scenario docs (target end-state).
  // ─────────────────────────────────────────────────────────────────────────

  // docs/test-cases/user-management/career-timeline/um-ct-03-pp-manual-add-backfill.md
  describe('um-ct-03 · assigned People Partner manually adds a backfill entry [DEFERRED]', () => {
    it.todo(
      'um-ct-03 · assigned PP POSTs a backfill entry → 201 source:"manual" — unblock: FR-permission-matrix grants profile:timeline:write to the People Partner role (matrix §6 item 4) + DEC-UM-001 assignee scoping (PP → own assignees only)',
    );
  });

  // docs/test-cases/user-management/career-timeline/um-ct-04-um-manual-add-backfill.md
  describe('um-ct-04 · direct Unit Manager manually adds a backfill entry [DEFERRED]', () => {
    it.todo(
      'um-ct-04 · direct Unit Manager POSTs a backfill entry → 201 source:"manual" — unblock: FR-permission-matrix grants profile:timeline:write to the Unit Manager role + DEC-UM-001 "direct UM" scoping, which needs the AC department-tree-walk increment (targetType:"department" + recursion)',
    );
  });

  // docs/test-cases/user-management/career-timeline/um-ct-09-permission-without-s9-write-denied.md
  describe('um-ct-09 · holds the functional permission but lacks the narrowed S9 write audience → denied [DEFERRED]', () => {
    it.todo(
      'um-ct-09 · a holder of profile:timeline:write who is not the assigned PP / direct UM POSTs an event → 403 — unblock: FR-permission-matrix grants profile:timeline:write to PP / Unit-Manager roles + DEC-UM-001 audience narrowing is wired (canAccessSection("profile:timeline", target) === "write"); today such a holder is allowed, not denied',
    );
  });

  // DEC-UM-001 narrowing (access-control.md §3.3 matrix exception): the broad
  // reporting line has a RW S9 read cell but is NOT the manual-write audience.
  describe('DEC-UM-001 narrowing · a reporting-line manager who is not the direct UM / PP → denied for manual add [DEFERRED]', () => {
    it.todo(
      'DEC-UM-001 · a non-direct reporting-line manager holding profile:timeline:write POSTs an event → 403 — unblock: FR-permission-matrix grants profile:timeline:write to PP / Unit-Manager roles + DEC-UM-001 audience narrowing lands (RW S9 read cell for the reporting line ≠ manual-write audience)',
    );
  });
});
