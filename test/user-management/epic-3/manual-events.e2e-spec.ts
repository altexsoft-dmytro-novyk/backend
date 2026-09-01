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
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/career-timeline/
 *     um-ct-03-pp-manual-add-backfill.md        (assigned PP → 201, source:'manual')
 *     um-ct-04-um-manual-add-backfill.md        (direct Unit Manager → 201)
 *     um-ct-09-permission-without-s9-write-denied.md   (dual-gate: section half fails)
 *     um-ct-10-s9-write-without-permission-denied.md   (dual-gate: feature half fails)
 *   plus a DEC-UM-001 narrowing test (broad reporting-line manager, not the
 *   direct UM / PP → denied even though the §3.2 S9 cell is RW for the line).
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *
 *  um-ct-03 / um-ct-04  RED — red-because-route-missing. `POST /users/:id/events`
 *            is not bound (`users.controller.ts` has `:id` GET/PATCH/PUT-photo
 *            and a collection-root GET/POST/DELETE only — no `/events`
 *            sub-routes), so the request 404s instead of 201, and there is no
 *            `UserEvents` model to persist a `source:'manual'` row. Green when
 *            Story 3.2 adds the route + `CreateUserEventDto` +
 *            `add-manual-user-event.service.ts` on top of Story 3.1's model.
 *
 *  um-ct-09  RED — red-because-route-missing today (404, not the target 403).
 *            PARTIALLY AC-BLOCKED: the S9-write half of the §2.2 dual gate is
 *            `AccessControlFacade.canAccessSection(actor,'S9',target) === 'write'`
 *            narrowed by DEC-UM-001 to assigned PP + direct Unit Manager;
 *            `canAccessSection` supports S1/S10/S11 only (ACM-5) — S9 is a
 *            pending Access Control increment. The negative is still first-class:
 *            a transitive/project-derived manager holding the functional
 *            permission must be denied and write nothing.
 *
 *  um-ct-10  RED — red-because-route-missing today (404, not 403). The feature
 *            half (`isAllowed(actor,'<edit-career-timeline>')`) is a no-target
 *            facade call available once Epic 0 rebinds the port; a direct Unit
 *            Manager who was never granted the permission must be denied.
 *
 *  DEC-UM-001 narrowing  RED — red-because-route-missing today (404, not 403).
 *            Same pending-S9 block as um-ct-09; asserts the §3.3 matrix
 *            exception directly (RW S9 cell for the reporting line ≠ manual-write
 *            audience).
 *
 * AMBIGUITY: the *edit the career timeline* permission key is unnamed on disk —
 * this suite uses `user-management:edit-career-timeline` (see fixtures.ts).
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

  // docs/test-cases/user-management/career-timeline/um-ct-03-pp-manual-add-backfill.md
  describe('um-ct-03 · assigned People Partner manually adds a backfill entry', () => {
    it('um-ct-03 · Paula POSTs a pre-system mentorship_end → 201 source:"manual", and it appears on GET [RED: no POST /users/:id/events route]', async () => {
      const paula = await fx.user('ct03-paula', { firstName: 'Paula' });
      const alice = await fx.user('ct03-alice', { firstName: 'Alice' });
      // Real assigned-PP edge (DEC-UM-001 write audience) + the runtime
      // *edit the career timeline* permission → both halves of the §2.2 dual
      // gate hold for Paula.
      await fx.peoplePartnerOf(alice.id, paula.id);
      await fx.grantFunctionalRole(paula.id, [CAREER_TIMELINE_PERMISSION_KEY]);

      // DEC-UM-011: the manual path may use any documented type, mentorship_end
      // included — this proves the manual backfill path only, not Epic 4's
      // automatic mentorship_end on relationship unpair.
      const write = await postEvent(alice.id, paula.id, {
        type: 'mentorship_end',
        eventDate: '2024-03-15',
        details: {},
      });
      expect(write.status).toBe(201);
      expect(write.body).toMatchObject({
        type: 'mentorship_end',
        source: 'manual',
      });
      const createdId = (write.body as { id?: string }).id;
      expect(createdId).toBeDefined();

      const list = await getEvents(alice.id, paula.id);
      expect(list.status).toBe(200);
      expect(list.body as Array<{ id: string }>).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: createdId })]),
      );
    });
  });

  // docs/test-cases/user-management/career-timeline/um-ct-04-um-manual-add-backfill.md
  describe('um-ct-04 · direct Unit Manager manually adds a backfill entry', () => {
    it('um-ct-04 · Bob (direct UM) POSTs a legacy entry → 201 source:"manual", and it appears on GET [RED: no POST /users/:id/events route]', async () => {
      const bob = await fx.user('ct04-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct04-alice', { firstName: 'Alice' });
      // Real `direct` edge Alice -> Bob (Bob = manager of Alice's department,
      // §4.17 — the DEC-UM-001 "direct Unit Manager") + the permission.
      await fx.reportsTo(alice.id, bob.id);
      await fx.grantFunctionalRole(bob.id, [CAREER_TIMELINE_PERMISSION_KEY]);

      const write = await postEvent(alice.id, bob.id, {
        type: 'joined_company',
        eventDate: '2019-06-01',
        details: {},
      });
      expect(write.status).toBe(201);
      expect(write.body).toMatchObject({ source: 'manual' });
      const createdId = (write.body as { id?: string }).id;
      expect(createdId).toBeDefined();

      const list = await getEvents(alice.id, bob.id);
      expect(list.status).toBe(200);
      expect(list.body as Array<{ id: string }>).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: createdId })]),
      );
    });
  });

  // docs/test-cases/user-management/career-timeline/um-ct-09-permission-without-s9-write-denied.md
  describe('um-ct-09 · holds the functional permission but lacks S9 write audience → denied', () => {
    it('um-ct-09 · a transitive manager (2 levels up) holding the permission POSTs an event → 403, nothing written [RED: route missing → 404; S9 canAccessSection pending]', async () => {
      const grandManager = await fx.user('ct09-grandmgr', {
        firstName: 'Grand',
      });
      const bob = await fx.user('ct09-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct09-alice', { firstName: 'Alice' });
      // Alice -> Bob -> Grand. Grand is a transitive manager: on the S9 read
      // line, but NOT Alice's direct Unit Manager and NOT her PP → read-only for
      // manual mutation under DEC-UM-001.
      await fx.reportsTo(alice.id, bob.id);
      await fx.reportsTo(bob.id, grandManager.id);
      await fx.grantFunctionalRole(grandManager.id, [
        CAREER_TIMELINE_PERMISSION_KEY,
      ]);

      const write = await postEvent(alice.id, grandManager.id, {
        type: 'grade_change',
        eventDate: '2023-01-01',
        details: {},
      });
      expect(write.status).toBe(403);

      // No event written or soft-deleted (DB-state — no GET route to trust).
      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });
  });

  // docs/test-cases/user-management/career-timeline/um-ct-10-s9-write-without-permission-denied.md
  describe('um-ct-10 · has the S9 write audience but lacks the functional permission → denied', () => {
    it('um-ct-10 · Bob (direct UM, no *edit the career timeline* grant) POSTs an event → 403, nothing written [RED: route missing → 404]', async () => {
      const bob = await fx.user('ct10-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct10-alice', { firstName: 'Alice' });
      // Bob IS Alice's direct Unit Manager (S9 write audience satisfied under
      // DEC-UM-001) but is NEVER granted the runtime permission — v1.5
      // correction: being the direct UM no longer implies the capability.
      await fx.reportsTo(alice.id, bob.id);

      const write = await postEvent(alice.id, bob.id, {
        type: 'grade_change',
        eventDate: '2023-01-01',
        details: {},
      });
      expect(write.status).toBe(403);

      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });
  });

  // DEC-UM-001 narrowing (access-control.md §3.3 matrix exception): the broad
  // reporting line has a RW S9 cell but is NOT the manual-write audience.
  describe('DEC-UM-001 narrowing · a reporting-line manager who is not the direct UM / PP → denied for manual add', () => {
    it('DEC-UM-001 · a non-direct reporting-line manager holding the permission POSTs an event → 403, nothing written [RED: route missing → 404; S9 canAccessSection pending]', async () => {
      // Directline manager over Bob's peer, one hop removed from Alice via a
      // department-style chain: Alice -> Bob (direct), lineManager also manages
      // Bob. lineManager sits on Alice's reporting line (RW S9 read cell) but is
      // not Alice's own direct Unit Manager and not her PP.
      const lineManager = await fx.user('decum001-linemgr', {
        firstName: 'Line',
      });
      const bob = await fx.user('decum001-bob', { firstName: 'Bob' });
      const alice = await fx.user('decum001-alice', { firstName: 'Alice' });
      await fx.reportsTo(alice.id, bob.id);
      await fx.reportsTo(bob.id, lineManager.id);
      await fx.grantFunctionalRole(lineManager.id, [
        CAREER_TIMELINE_PERMISSION_KEY,
      ]);

      const write = await postEvent(alice.id, lineManager.id, {
        type: 'position_change',
        eventDate: '2022-05-01',
        details: { from: 'Junior Engineer', to: 'Engineer' },
      });
      expect(write.status).toBe(403);

      expect(await queryUserEvents(testApp.prisma, alice.id)).toHaveLength(0);
    });
  });
});
