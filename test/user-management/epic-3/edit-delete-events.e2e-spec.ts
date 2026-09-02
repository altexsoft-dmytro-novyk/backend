import { randomUUID } from 'node:crypto';
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
 * Contract (source of truth):
 *   docs/test-cases/user-management/career-timeline/README.md — the split-gate
 *   decision table + the "Story 3.3 — the soft-delete / correction gate"
 *   section (Dmytro, 2026-09-03).
 *   docs/test-cases/user-management/career-timeline/
 *     um-ct-05-pp-correct-event-soft-delete-and-append.md   (DEFERRED — it.todo)
 *     um-ct-06-um-delete-event.md                           (DEFERRED — it.todo)
 *     um-ct-07-deleted-event-excluded-from-read.md          (LIVE, retargeted to Root)
 *     um-ct-08-direct-edit-rejected.md                      (LIVE, retargeted to Root)
 *     um-ct-13-hr-admin-deletes-and-corrects.md             (LIVE — the one soft-delete path 3.3 ships)
 *   _bmad-output/implementation-artifacts/user-management/
 *     spec-3-3-authorized-actor-edits-or-deletes-an-event.md
 *
 * ── The gate this story ships ──────────────────────────────────────────────
 *
 *  Story 3.3 adds `DELETE /users/:id/events/:eventId` — SOFT-DELETE ONLY
 *  (`deletedAt` set, the row persists, `deletedAt` never exposed). It follows
 *  Story 3.2's shape EXACTLY: the delete gate is
 *  `isAllowed(actor, 'profile:timeline:write')` ALONE — a feature action, no
 *  data-audience half. `profile:timeline:write` is seeded and granted to the
 *  `hr-admin` role only; the E2E grants it in-test via `fx.grantFunctionalRole`.
 *
 *  Gate ordering: permission check first → `403` (also covers a non-existent
 *  `:id`, no `404` enumeration surface), THEN the `(:id, :eventId)`-scoped
 *  lookup → `404` for a missing / already-soft-deleted / cross-timeline row.
 *
 *  Approved Stage-1 decisions encoded in the assertions:
 *   - `DELETE` success → `204 No Content`, empty body.
 *   - Unknown `eventId` → `404`. Already-soft-deleted `eventId` → `404` (NOT an
 *     idempotent `204`).
 *   - Cross-timeline `DELETE` (`/users/<otherId>/events/<eventId>` where the
 *     event's `userId ≠ otherId`) → `404`.
 *   - "Correction" = two client calls — `DELETE` then Story 3.2's `POST`. NO
 *     `PATCH` on a single event.
 *
 * ── RED / GREEN classification ─────────────────────────────────────────────
 *
 *  The `POST` (seed) and `GET` (`{ data, canEdit }` envelope) steps PASS today —
 *  Stories 3.1/3.2 shipped those routes. Every Story 3.3 assertion is targeted-
 *  red on the missing `DELETE` route:
 *
 *   um-ct-07  LIVE. Seed + baseline `GET` PASS; the `DELETE` → `204` step and the
 *             post-delete "event absent from the read" step are RED —
 *             red-because-`DELETE`-route-missing (the route 404s, so the
 *             soft-delete never happens and the row stays in `data`).
 *
 *   um-ct-08  LIVE, all GREEN today and stays green after Story 3.3 (which adds
 *             only `DELETE`): the seed `POST` → 201, `PATCH` on a single event →
 *             404 (no route bound, by design — the immutable-fact model has no
 *             in-place edit), and the follow-up `GET` shows the event unchanged.
 *             A green-characterization guard that the `PATCH` route stays absent.
 *
 *   um-ct-13  LIVE. Test 1/2/3/5 RED — red-because-`DELETE`-route-missing (`204`
 *             expected, `404` returned; `403`/`401` gate never reached because no
 *             route matches). Test 4 is MIXED — the "unknown id → 404" and
 *             "re-delete → 404" legs pass coincidentally today (nothing is
 *             bound), the "first delete → 204" leg is RED. Test 6 (cross-timeline
 *             → 404) passes coincidentally today and stays green once the scoped
 *             `(:id, :eventId)` lookup lands.
 *
 *  um-ct-05 / um-ct-06 are DEFERRED `it.todo` — the delete gate ships as an
 *  HR-Admin feature action with no data-audience half, so a People Partner /
 *  Unit Manager cannot delete yet. Each todo states its unblock trigger. The
 *  target-end-state prose lives in the scenario docs, not duplicated here.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, no provider
 * overrides. DEC-UM-010: one worker, run-namespaced data, wrapped scoped
 * teardown (events -> relationships -> policies/permissions -> users). Within a
 * describe the `it`s run in declaration order and thread real ids through
 * closure variables — never a hardcoded event id.
 */
describe('Epic 3 · Edit / delete events — DELETE (+ no PATCH) /users/:id/events/:eventId (e2e, committed red)', () => {
  let testApp: TestApp;

  type EventsEnvelope = {
    data: Array<Record<string, unknown>>;
    canEdit: boolean;
  };

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

  // A Root/HR-Admin persona that holds `profile:timeline:write`. The real
  // `hr-admin` default seed does not carry this key yet (career-timeline
  // README — the kernel "exactly three" drift guard), so grant it explicitly
  // in-test: the suite is then red ONLY on the missing `DELETE` route, never on
  // a missing grant.
  const seedTimelineWriter = async (fx: RunFixtures, persona: string) => {
    const actor = await fx.user(persona, { firstName: 'Root' });
    await fx.grantFunctionalRole(actor.id, [CAREER_TIMELINE_PERMISSION_KEY]);
    return actor;
  };

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEFERRED — `it.todo`. Target-end-state prose lives in the scenario docs.
  // ─────────────────────────────────────────────────────────────────────────

  // docs/test-cases/user-management/career-timeline/um-ct-05-pp-correct-event-soft-delete-and-append.md
  describe('um-ct-05 · assigned People Partner corrects a wrongly-inferred event (soft-delete + append) [DEFERRED]', () => {
    it.todo(
      'um-ct-05 · assigned PP soft-deletes the wrong event + POSTs the correction for her own assignee → 204 / 201, and the same for a non-assignee → 403 — unblock: FR-permission-matrix grants profile:timeline:write to the People Partner role (matrix §6 item 4) + DEC-UM-001 assignee scoping is wired (canAccessSection("profile:timeline", target) === "write" narrowed to the assigned-PP edge)',
    );
  });

  // docs/test-cases/user-management/career-timeline/um-ct-06-um-delete-event.md
  describe('um-ct-06 · direct Unit Manager soft-deletes an event [DEFERRED]', () => {
    it.todo(
      'um-ct-06 · direct Unit Manager DELETEs an event for a member of his own department → 204, and the same for someone outside it → 403 — unblock: FR-permission-matrix grants profile:timeline:write to the Unit Manager role + the AC department-tree-walk increment (targetType:"department" + recursion) for DEC-UM-001 "direct UM" scoping',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-07 — a soft-deleted event is absent (not null) from the read — LIVE
  // docs/test-cases/user-management/career-timeline/um-ct-07-deleted-event-excluded-from-read.md
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-07 · a soft-deleted event is entirely absent from the timeline read [LIVE — actor-agnostic data-correctness property, retargeted to Root]', () => {
    let fx: RunFixtures;
    let rootId: string;
    let aliceId: string;
    let deletedEventId: string | undefined;
    let survivingEventId: string | undefined;

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const root = await seedTimelineWriter(fx, 'ct07-root');
      const alice = await fx.user('ct07-alice', { firstName: 'Alice' });
      rootId = root.id;
      aliceId = alice.id;
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it('um-ct-07 · seeds two events on Alice’s timeline via POST (Root holds profile:timeline:write) [seed step — PASSES: POST route shipped by Story 3.2]', async () => {
      const a = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2020-01-01',
        details: { grade: 'M1' },
      });
      expect(a.status).toBe(201);
      deletedEventId = (a.body as { id?: string }).id;
      expect(deletedEventId).toEqual(expect.any(String));

      const b = await postEvent(aliceId, rootId, {
        type: 'position_change',
        eventDate: '2021-06-01',
        details: { position: 'Engineer' },
      });
      expect(b.status).toBe(201);
      survivingEventId = (b.body as { id?: string }).id;
      expect(survivingEventId).toEqual(expect.any(String));
    });

    it('um-ct-07 · baseline: both events are on the read — 200 { data, canEdit:true } [baseline step — PASSES: GET envelope shipped by Story 3.1/3.2]', async () => {
      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      const body = res.body as EventsEnvelope;
      expect(body.canEdit).toBe(true);
      expect(body.data.some((e) => e.id === deletedEventId)).toBe(true);
      expect(body.data.some((e) => e.id === survivingEventId)).toBe(true);
    });

    it('um-ct-07 · Root soft-deletes one event → 204 No Content, empty body [RED: no DELETE /users/:id/events/:eventId route → 404, empty body absent]', async () => {
      const res = await deleteEvent(
        aliceId,
        deletedEventId ?? 'missing',
        rootId,
      );
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      // Soft-delete: the row persists but drops out of the active-rows query.
      expect(
        (await queryUserEvents(testApp.prisma, aliceId)).some(
          (e) => e.id === deletedEventId,
        ),
      ).toBe(false);
    });

    it('um-ct-07 · the soft-deleted event is absent from the read — not null, no deletedAt key; the other event survives [RED: DELETE route missing → soft-delete never happened → event still in data]', async () => {
      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      const body = res.body as EventsEnvelope;
      // Absence is absence — the id is gone entirely.
      expect(body.data.some((e) => e.id === deletedEventId)).toBe(false);
      // The unrelated event is untouched.
      expect(body.data.some((e) => e.id === survivingEventId)).toBe(true);
      // No null placeholder entries; no `deletedAt` leak on any returned event.
      expect(body.data.some((e) => e === null)).toBe(false);
      for (const e of body.data) {
        expect(e).not.toHaveProperty('deletedAt');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-08 — a direct PATCH on an event is rejected (no in-place edit route)
  // docs/test-cases/user-management/career-timeline/um-ct-08-direct-edit-rejected.md
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-08 · direct PATCH of a career-timeline event is rejected [LIVE — actor-agnostic; no PATCH route bound, retargeted to Root]', () => {
    let fx: RunFixtures;
    let rootId: string;
    let aliceId: string;
    let eventId: string | undefined;
    const originalDetails = { position: 'Engineer' };

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const root = await seedTimelineWriter(fx, 'ct08-root');
      const alice = await fx.user('ct08-alice', { firstName: 'Alice' });
      rootId = root.id;
      aliceId = alice.id;
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it('um-ct-08 · seeds an event via POST (Root) [seed step — PASSES: POST route shipped by Story 3.2]', async () => {
      const res = await postEvent(aliceId, rootId, {
        type: 'position_change',
        eventDate: '2021-06-01',
        details: originalDetails,
      });
      expect(res.status).toBe(201);
      eventId = (res.body as { id?: string }).id;
      expect(eventId).toEqual(expect.any(String));
    });

    it('um-ct-08 · PATCH /users/:id/events/:eventId → 404 or 405 (no route bound, by design) [GREEN-characterization / forward: route absent, stays absent after Story 3.3]', async () => {
      const res = await request(testApp.app.getHttpServer())
        .patch(`/users/${aliceId}/events/${eventId ?? 'missing'}`)
        .set('authorization', bearer(rootId))
        .send({ details: { note: 'direct edit attempt' } });
      expect([404, 405]).toContain(res.status);
      // The sanctioned way to correct an entry is um-ct-13's soft-delete +
      // append sequence — never this PATCH.
    });

    it('um-ct-08 · the event is unchanged on a subsequent read — no field reflects the attempted details [GREEN: PATCH was not routed, so nothing changed]', async () => {
      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      const body = res.body as EventsEnvelope;
      const event = body.data.find((e) => e.id === eventId);
      expect(event).toBeDefined();
      expect(event).toMatchObject({
        type: 'position_change',
        source: 'manual',
        details: originalDetails,
      });
      expect(event?.details).not.toMatchObject({ note: 'direct edit attempt' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // um-ct-13 — HR Admin soft-deletes an event and runs the correction flow — LIVE
  // docs/test-cases/user-management/career-timeline/um-ct-13-hr-admin-deletes-and-corrects.md
  // ─────────────────────────────────────────────────────────────────────────
  describe('um-ct-13 · HR Admin (Root) soft-deletes an event and runs the correction flow [LIVE — the one soft-delete / correction path Story 3.3 ships]', () => {
    let fx: RunFixtures;
    let rootId: string;
    let aliceId: string;
    let bobId: string;

    beforeAll(async () => {
      fx = new RunFixtures(testApp.prisma);
      const root = await seedTimelineWriter(fx, 'ct13-root');
      const alice = await fx.user('ct13-alice', { firstName: 'Alice' });
      // Bob is Alice's direct Unit Manager but holds NO `profile:timeline:write`
      // — the feature-permission gate alone denies him (relationship irrelevant
      // at this stage; um-ct-10).
      const bob = await fx.user('ct13-bob', { firstName: 'Bob' });
      rootId = root.id;
      aliceId = alice.id;
      bobId = bob.id;
      await fx.reportsTo(alice.id, bob.id);
    });

    afterAll(async () => {
      await cleanupUserEvents(testApp.prisma, fx.userIds);
      await fx.cleanup();
    });

    it('um-ct-13 Test 1 · Root seeds an event then soft-deletes it → 204 No Content, empty body; the row persists soft-deleted [RED: no DELETE route → 404, not 204]', async () => {
      const seed = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2019-04-01',
        details: { grade: 'M2' },
      });
      expect(seed.status).toBe(201);
      const eventId = (seed.body as { id?: string }).id;
      expect(eventId).toEqual(expect.any(String));

      const del = await deleteEvent(aliceId, eventId ?? 'missing', rootId);
      expect(del.status).toBe(204);
      expect(del.body).toEqual({});
      // The row persists with `deletedAt` set — verified by the direct
      // repository read (the API never exposes `deletedAt`), which excludes it.
      expect(
        (await queryUserEvents(testApp.prisma, aliceId)).some(
          (e) => e.id === eventId,
        ),
      ).toBe(false);
    });

    it('um-ct-13 Test 2 · the soft-deleted event is absent from the read — not null, no deletedAt key [RED: DELETE route missing → soft-delete never happened → event still in data]', async () => {
      const seed = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2019-05-01',
        details: { grade: 'M3' },
      });
      expect(seed.status).toBe(201);
      const eventId = (seed.body as { id?: string }).id;

      const del = await deleteEvent(aliceId, eventId ?? 'missing', rootId);
      expect(del.status).toBe(204);

      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      const body = res.body as EventsEnvelope;
      expect(body.canEdit).toBe(true);
      expect(body.data.some((e) => e.id === eventId)).toBe(false);
      expect(body.data.some((e) => e === null)).toBe(false);
      for (const e of body.data) {
        expect(e).not.toHaveProperty('deletedAt');
      }
    });

    it('um-ct-13 Test 3 · full correction flow — DELETE the wrong entry, POST the corrected one, GET shows only the correction [RED: no DELETE route → wrong entry never soft-deleted]', async () => {
      const wrong = await postEvent(aliceId, rootId, {
        type: 'position_change',
        eventDate: '2022-02-01',
        details: { position: 'Sr. Enginer' },
      });
      expect(wrong.status).toBe(201);
      const wrongId = (wrong.body as { id?: string }).id;

      const del = await deleteEvent(aliceId, wrongId ?? 'missing', rootId);
      expect(del.status).toBe(204);

      const corrected = await postEvent(aliceId, rootId, {
        type: 'position_change',
        eventDate: '2022-02-01',
        details: { position: 'Senior Engineer' },
      });
      expect(corrected.status).toBe(201);
      const rightId = (corrected.body as { id?: string }).id;
      expect(rightId).toEqual(expect.any(String));
      expect(rightId).not.toBe(wrongId);
      expect(corrected.body).toMatchObject({ source: 'manual' });

      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      const { data } = res.body as EventsEnvelope;
      expect(data.some((e) => e.id === rightId)).toBe(true);
      expect(data.some((e) => e.id === wrongId)).toBe(false);
      expect(
        data.some(
          (e) =>
            (e.details as { position?: string } | undefined)?.position ===
            'Sr. Enginer',
        ),
      ).toBe(false);
      expect(data.find((e) => e.id === rightId)?.details).toMatchObject({
        position: 'Senior Engineer',
      });
    });

    it('um-ct-13 Test 4 · DELETE of an unknown or already-soft-deleted eventId → 404 (not an idempotent 204) [MIXED: unknown-id / re-delete legs pass coincidentally today; the first delete → 204 leg is RED]', async () => {
      // A syntactically-valid but unknown id.
      const unknown = await deleteEvent(aliceId, randomUUID(), rootId);
      expect(unknown.status).toBe(404);

      const seed = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2019-06-01',
        details: {},
      });
      expect(seed.status).toBe(201);
      const eventId = (seed.body as { id?: string }).id ?? 'missing';

      const first = await deleteEvent(aliceId, eventId, rootId);
      expect(first.status).toBe(204);

      // Second DELETE of a now-soft-deleted row: 404, NOT an idempotent 204 —
      // "absence is absence", the row does not exist from the caller's vantage.
      const second = await deleteEvent(aliceId, eventId, rootId);
      expect(second.status).toBe(404);
    });

    it('um-ct-13 Test 5 · Bob (no profile:timeline:write) → 403; no Authorization header → 401; the event is untouched [RED: no DELETE route → 404, the 403/401 gate is never reached]', async () => {
      const seed = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2019-07-01',
        details: {},
      });
      expect(seed.status).toBe(201);
      const eventId = (seed.body as { id?: string }).id ?? 'missing';

      const denied = await deleteEvent(aliceId, eventId, bobId);
      expect(denied.status).toBe(403);

      const unauth = await request(testApp.app.getHttpServer()).delete(
        `/users/${aliceId}/events/${eventId}`,
      );
      expect(unauth.status).toBe(401);

      // The event is still there.
      const res = await getEvents(aliceId, rootId);
      expect(res.status).toBe(200);
      expect(
        (res.body as EventsEnvelope).data.some((e) => e.id === eventId),
      ).toBe(true);
    });

    it('um-ct-13 Test 6 · cross-timeline DELETE /users/<bobId>/events/<aliceEventId> → 404; the event stays on Alice’s timeline [passes coincidentally today (no route); stays green once the scoped (:id,:eventId) lookup lands]', async () => {
      const seed = await postEvent(aliceId, rootId, {
        type: 'grade_change',
        eventDate: '2019-08-01',
        details: {},
      });
      expect(seed.status).toBe(201);
      const aliceEventId = (seed.body as { id?: string }).id ?? 'missing';

      const res = await deleteEvent(bobId, aliceEventId, rootId);
      expect(res.status).toBe(404);

      // Nothing soft-deleted — the event is still on Alice's timeline.
      const check = await getEvents(aliceId, rootId);
      expect(check.status).toBe(200);
      expect(
        (check.body as EventsEnvelope).data.some((e) => e.id === aliceEventId),
      ).toBe(true);
    });
  });
});
