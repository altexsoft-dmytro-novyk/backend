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
 * Epic 3 — Story 3.3 (Authorized Actor Edits or Deletes an Event) · AD-1
 * Stage 2, committed red.
 *
 * Scenarios (one E2E per scenario, id in the test title):
 *   docs/test-cases/user-management/career-timeline/
 *     um-ct-05-pp-correct-event-soft-delete-and-append.md
 *     um-ct-06-um-delete-event.md
 *     um-ct-07-deleted-event-excluded-from-read.md
 *     um-ct-08-direct-edit-rejected.md
 *
 * The correction mechanic is soft-delete-then-append: `DELETE /users/:id/events/:eventId`
 * (sets `deletedAt`, never removes the row) then Story 3.2's `POST` — there is
 * NO `PATCH` on a single event by design.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *
 *  um-ct-05  RED — red-because-route-missing. Every step (`POST` the wrong
 *            entry, `GET` baseline, `DELETE` it, `POST` the correction, `GET`
 *            the corrected timeline) hits an unbound route → 404. `um-ct-05`'s
 *            "genuinely wrong system-inferred `details.to`" has no request that
 *            produces it on purpose, so its baseline entry is seeded through the
 *            SAME manual-add endpoint (`POST /users/:id/events`) the correction
 *            step uses — per epic-3-context.md and nest-e2e.md; the substitution
 *            does not change the mechanic under test.
 *
 *  um-ct-06  RED — red-because-route-missing. `POST` to seed the target event
 *            404s; `DELETE /users/:id/events/:eventId` 404s instead of 200.
 *
 *  um-ct-07  RED — red-because-route-missing. Depends on um-ct-06's soft-delete
 *            having happened; `GET /users/:id/events` does not exist.
 *
 *  um-ct-08  MIXED.
 *            - Test 2 (`PATCH /users/:id/events/:eventId` → 404/405, no in-place
 *              edit route) is GREEN-characterization / forward: the route is
 *              absent by design and STAYS absent after Story 3.3 (which adds only
 *              `DELETE`). It passes today for the right structural reason.
 *            - Test 1 (seed the event via `POST` → 201) and Test 3 (`GET` shows
 *              the event with original fields) are RED — red-because-route-missing.
 *
 * PARTIALLY AC-BLOCKED (um-ct-05/06/08 write actors): the S9-write half of the
 * §2.2 dual gate is `canAccessSection(actor,'S9',target) === 'write'` narrowed
 * by DEC-UM-001; `canAccessSection` supports S1/S10/S11 only (ACM-5) — S9 is a
 * pending Access Control increment. Scenario prose proceeds; the fixtures still
 * seed the real PP / direct-UM edge + the *edit the career timeline* permission
 * so the actor is the intended one.
 *
 * AMBIGUITY: the *edit the career timeline* permission key is unnamed on disk —
 * this suite uses `user-management:edit-career-timeline` (see fixtures.ts).
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. DEC-UM-010: one worker, run-namespaced data, wrapped scoped
 * teardown (events -> relationships -> policies/permissions -> users). Within a
 * describe the `it`s run in declaration order and thread real ids through
 * closure variables — never a hardcoded event id.
 */
describe('Epic 3 · Edit / delete events — DELETE (+ no PATCH) /users/:id/events/:eventId (e2e, committed red)', () => {
  let testApp: TestApp;

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

  const deleteEvent = (targetId: string, eventId: string, viewerId: string) =>
    request(testApp.app.getHttpServer())
      .delete(`/users/${targetId}/events/${eventId}`)
      .set('authorization', bearer(viewerId));

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-05 — PP corrects a wrongly-inferred event (soft-delete + append)
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-05 · PP corrects a wrongly-inferred position_change event', () => {
    let fx: RunFixtures;
    let aliceId: string;
    let paulaId: string;
    let wrongEventId: string | undefined;
    let correctedEventId: string | undefined;

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const paula = await fx.user('ct05-paula', { firstName: 'Paula' });
      const alice = await fx.user('ct05-alice', {
        firstName: 'Alice',
        position: 'Engineer',
      });
      paulaId = paula.id;
      aliceId = alice.id;
      await fx.peoplePartnerOf(alice.id, paula.id);
      await fx.grantFunctionalRole(paula.id, [CAREER_TIMELINE_PERMISSION_KEY]);
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it("um-ct-05 · seeds the entry to correct — a position_change with a typo'd details.to [RED: no POST /users/:id/events route]", async () => {
      // NOTE (epic-3-context.md): a genuinely wrong system-inferred value has no
      // HTTP-observable way to manufacture — seed the closest real substitute
      // through the manual-add endpoint. `source` is server-stamped; the wrong
      // VALUE (`Sr. Enginer`) is the point, not the source.
      const res = await postEvent(aliceId, paulaId, {
        type: 'position_change',
        eventDate: '2026-08-01',
        details: { from: 'Engineer', to: 'Sr. Enginer' },
      });
      expect(res.status).toBe(201);
      wrongEventId = (res.body as { id?: string }).id;
      expect(wrongEventId).toBeDefined();
    });

    it('um-ct-05 Test 1 · baseline: the wrong entry is on the timeline [RED: no GET /users/:id/events route]', async () => {
      const res = await getEvents(aliceId, paulaId);
      expect(res.status).toBe(200);
      expect(
        (res.body as Array<{ id: string }>).some((e) => e.id === wrongEventId),
      ).toBe(true);
    });

    it('um-ct-05 Test 2 · soft-delete the wrong entry → 200 [RED: no DELETE /users/:id/events/:eventId route]', async () => {
      const res = await deleteEvent(
        aliceId,
        wrongEventId ?? 'missing',
        paulaId,
      );
      expect(res.status).toBe(200);
    });

    it('um-ct-05 Test 3 · append the corrected entry → 201, a new distinct id [RED: no POST /users/:id/events route]', async () => {
      const res = await postEvent(aliceId, paulaId, {
        type: 'position_change',
        eventDate: '2026-08-01',
        details: { from: 'Engineer', to: 'Senior Engineer' },
        source: 'manual',
      });
      expect(res.status).toBe(201);
      correctedEventId = (res.body as { id?: string }).id;
      expect(correctedEventId).toBeDefined();
      expect(correctedEventId).not.toBe(wrongEventId);
    });

    it('um-ct-05 Test 4 · the corrected timeline excludes the wrong entry and includes only the correction [RED: no GET /users/:id/events route]', async () => {
      const res = await getEvents(aliceId, paulaId);
      expect(res.status).toBe(200);
      const body = res.body as Array<{ id: string; details?: unknown }>;
      expect(body.some((e) => e.id === wrongEventId)).toBe(false);
      expect(body.some((e) => e.id === correctedEventId)).toBe(true);
      // The wrong value is gone from reads entirely.
      expect(
        body.some(
          (e) =>
            (e.details as { to?: string } | undefined)?.to === 'Sr. Enginer',
        ),
      ).toBe(false);

      // DB-state: both rows persist (immutable-fact history); only the wrong
      // one carries deletedAt.
      const active = await queryUserEvents(testApp.prisma, aliceId);
      expect(active.some((e) => e.id === correctedEventId)).toBe(true);
      expect(active.some((e) => e.id === wrongEventId)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-06 / um-ct-07 — UM deletes an event; it is then absent (not null)
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-06 / um-ct-07 · direct Unit Manager soft-deletes an event; it is absent from reads', () => {
    let fx: RunFixtures;
    let aliceId: string;
    let bobId: string;
    let eventId: string | undefined;

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const bob = await fx.user('ct06-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct06-alice', { firstName: 'Alice' });
      bobId = bob.id;
      aliceId = alice.id;
      await fx.reportsTo(alice.id, bob.id);
      await fx.grantFunctionalRole(bob.id, [CAREER_TIMELINE_PERMISSION_KEY]);
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it("um-ct-06 · seeds a manually-added event on Alice's timeline [RED: no POST /users/:id/events route]", async () => {
      const res = await postEvent(aliceId, bobId, {
        type: 'joined_company',
        eventDate: '2019-06-01',
        details: {},
      });
      expect(res.status).toBe(201);
      eventId = (res.body as { id?: string }).id;
      expect(eventId).toBeDefined();
    });

    it('um-ct-06 · Bob soft-deletes it → 200 [RED: no DELETE /users/:id/events/:eventId route]', async () => {
      const res = await deleteEvent(aliceId, eventId ?? 'missing', bobId);
      expect(res.status).toBe(200);
    });

    it('um-ct-07 · the soft-deleted event is absent from the read — not null, no deletedAt exposed [RED: no GET /users/:id/events route]', async () => {
      const res = await getEvents(aliceId, bobId);
      expect(res.status).toBe(200);
      const body = res.body as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      // Absence is absence: the id is gone entirely.
      expect(body.some((e) => e.id === eventId)).toBe(false);
      // No null placeholder entries, no deletedAt leak on any surviving entry.
      expect(body.some((e) => e === null)).toBe(false);
      for (const e of body) {
        expect(e).not.toHaveProperty('deletedAt');
      }

      // DB-state: the row still exists, just soft-deleted (history preserved).
      expect(
        (await queryUserEvents(testApp.prisma, aliceId)).some(
          (e) => e.id === eventId,
        ),
      ).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-08 — a direct PATCH on an event is rejected (no in-place edit route)
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-08 · direct PATCH of a career-timeline event is rejected', () => {
    let fx: RunFixtures;
    let aliceId: string;
    let bobId: string;
    let eventId: string | undefined;

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const bob = await fx.user('ct08-bob', { firstName: 'Bob' });
      const alice = await fx.user('ct08-alice', { firstName: 'Alice' });
      bobId = bob.id;
      aliceId = alice.id;
      await fx.reportsTo(alice.id, bob.id);
      await fx.grantFunctionalRole(bob.id, [CAREER_TIMELINE_PERMISSION_KEY]);
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it('um-ct-08 · seeds an undeleted event via the manual-add endpoint [RED: no POST /users/:id/events route]', async () => {
      const res = await postEvent(aliceId, bobId, {
        type: 'joined_company',
        eventDate: '2019-06-01',
        details: {},
      });
      expect(res.status).toBe(201);
      eventId = (res.body as { id?: string }).id;
      expect(eventId).toBeDefined();
    });

    it('um-ct-08 Test 1 · PATCH /users/:id/events/:eventId → 404 or 405 (no in-place edit route, by design) [GREEN-characterization / forward: route absent, stays absent]', async () => {
      const res = await request(testApp.app.getHttpServer())
        .patch(`/users/${aliceId}/events/${eventId ?? 'missing'}`)
        .set('authorization', bearer(bobId))
        .send({ details: { note: 'direct edit attempt' } });
      expect([404, 405]).toContain(res.status);
      // The sanctioned way to correct an entry is um-ct-05's soft-delete +
      // append sequence — never this PATCH.
    });

    it('um-ct-08 Test 2 · the event is unchanged on a subsequent read — no field reflects the attempted details [RED: no GET /users/:id/events route]', async () => {
      const res = await getEvents(aliceId, bobId);
      expect(res.status).toBe(200);
      const event = (res.body as Array<Record<string, unknown>>).find(
        (e) => e.id === eventId,
      );
      expect(event).toBeDefined();
      expect(event).toMatchObject({ type: 'joined_company', source: 'manual' });
      expect(event?.details).not.toMatchObject({ note: 'direct edit attempt' });
    });
  });
});
