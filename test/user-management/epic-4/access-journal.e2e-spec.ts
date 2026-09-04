import request from 'supertest';
import {
  ORG_RELATIONSHIPS_WRITE_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  cleanupAccessJournal,
  queryAccessJournalRows,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · `um-rel-15` (Access journal —
 * append-only, idempotent write, reader-authorized read) · AD-1 Stage 2,
 * committed red.
 *
 * Scenario: docs/test-cases/user-management/relationships/
 *   um-rel-15-access-journal-read-and-idempotency.md
 *
 * This file pins the `AccessJournal` table's own invariants (Story 4.1 stands it
 * up alongside the already-present `Relationship` model) and the
 * `GET /users/:id/access-journal` read + reader-authz matrix. Story 4.1 only
 * ever WRITES `kind: 'manager'` — the `manager` write paths themselves are in
 * `manager-change.e2e-spec.ts`.
 *
 * WHY RED (per test):
 *   - **red-because-route-missing** — `POST/DELETE /users/:id/relationships` and
 *     `GET /users/:id/access-journal` do not exist (`users.controller.ts` has no
 *     `relationships` / `access-journal` handler), so every call 404s.
 *   - **red-because-model-missing** — the `access_journal` table + its
 *     same-transaction writer are absent. `queryAccessJournalRows` is
 *     `to_regclass`-guarded and returns `[]`, so "exactly one row" reads as a
 *     clean red rather than a "relation does not exist" throw.
 *
 * Interim read-authz gate (`// INTERIM`, expiry = the §2.4 `full`-audience
 * resolver reaching stage-3-production — `deferred-work.md`):
 *   `resolveAudiences(viewer, [subject]) ∩ { reporting, pp } ≠ ∅ → 200`, else
 *   `403`. **Self is not a reader. HR Admin by functional role alone is not a
 *   reader** (access-control.md §3.4). No token → `401`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010 isolation. Test 3 depends on REAL Phase-0
 * audiences, so it seeds real `User` + `Relationship` rows and authenticates
 * `Bearer <token:<seeded-uuid>>` (a persona literal resolves to a non-existent
 * id → empty audience → `403`).
 */
describe('Epic 4 · um-rel-15 — Access journal (e2e, committed red)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();

  const postRel = (
    employeeId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`/users/${employeeId}/relationships`)
      .set('authorization', bearer(viewerId))
      .send(body);
  const deleteRel = (
    employeeId: string,
    relationshipId: string,
    viewerId: string,
  ) =>
    request(server())
      .delete(`/users/${employeeId}/relationships/${relationshipId}`)
      .set('authorization', bearer(viewerId));
  const getJournal = (subjectId: string, viewerId?: string) => {
    const req = request(server()).get(`/users/${subjectId}/access-journal`);
    return viewerId ? req.set('authorization', bearer(viewerId)) : req;
  };

  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);
    return root;
  };

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
  });

  afterEach(async () => {
    await cleanupAccessJournal(testApp.prisma, fx.userIds);
    await fx.cleanup();
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // Test 1 — append-only ------------------------------------------------
  it('T1 · append-only — no route mutates a journal row; an earlier row is byte-identical after a later unrelated mutation', async () => {
    const root = await seedActor('rel15t1-root');
    const alice = await fx.user('rel15t1-alice');
    const bob = await fx.user('rel15t1-bob');

    const created = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(created.status).toBe(201);
    const relationshipId = (created.body as { id?: string }).id;

    const before = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    expect(before).toHaveLength(1);
    const originalRow = before[0];

    // No PATCH / PUT / DELETE surface for a journal row anywhere in the router
    // tree (api-conventions.md — the only journal route is the GET).
    for (const method of ['patch', 'put', 'delete'] as const) {
      const probe = await request(server())
        [method](`/users/${alice.id}/access-journal/${originalRow?.id}`)
        .set('authorization', bearer(bob.id));
      expect([404, 405]).toContain(probe.status);
    }

    // A later unrelated mutation on Alice's edge (revoke, then re-assign) only
    // APPENDS rows — the earlier row is never touched.
    await deleteRel(alice.id, String(relationshipId), root.id);
    await postRel(alice.id, root.id, { type: 'direct', targetId: bob.id });

    const after = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    const stillThere = after.find((r) => r.id === originalRow?.id);
    expect(stillThere).toEqual(originalRow);
    expect(after.length).toBeGreaterThan(before.length);
  });

  // Test 2 — idempotent write -----------------------------------------
  it('T2 · idempotent write — after a retried create hits the `direct` UNIQUE 409, exactly one `manager` journal row for the subject', async () => {
    const root = await seedActor('rel15t2-root');
    const alice = await fx.user('rel15t2-alice');
    const bob = await fx.user('rel15t2-bob');

    const first = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(first.status).toBe(201);

    // Same logical create retried (same actor, subject, target) — the client did
    // not observe the first response.
    const retry = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(retry.status).toBe(409);

    // The fact write did not happen a second time, so the journal write did not
    // either: exactly one `manager` row. (Where a writer instead reaches the
    // same fact transition without a 409, the `idempotencyKey` UNIQUE /
    // ON CONFLICT DO NOTHING guard is what holds it to one — same assertion.)
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]?.idempotencyKey).toBeTruthy();
  });

  // Test 3 — read + reader authorization -----------------------------
  describe('T3 · read + reader authorization', () => {
    let alice: Awaited<ReturnType<RunFixtures['user']>>;
    let bob: Awaited<ReturnType<RunFixtures['user']>>;
    let paula: Awaited<ReturnType<RunFixtures['user']>>;
    let eve: Awaited<ReturnType<RunFixtures['user']>>;
    let hrAdmin: Awaited<ReturnType<RunFixtures['user']>>;

    beforeEach(async () => {
      alice = await fx.user('rel15t3-alice');
      bob = await fx.user('rel15t3-bob');
      paula = await fx.user('rel15t3-paula');
      eve = await fx.user('rel15t3-eve');
      // HR Admin by functional role only — holds `org:relationships:write` (so
      // it is also the write actor for the seeding POST below), has NO
      // relationship edge to Alice. Per §3.4 it can change the fact but is
      // explicitly NOT a journal reader.
      hrAdmin = await seedActor('rel15t3-hradmin');

      // Alice → Paula assigned-PP edge — a real Phase-0 `pp` audience. Seeded
      // directly (Story 4.2's `PUT .../people-partner` route doesn't exist yet).
      await fx.peoplePartnerOf(alice.id, paula.id);

      // The Alice → Bob Reporting-line edge is created through the route under
      // test, which also writes the `manager` journal row this scenario reads
      // back (um-rel-01 path). Red today: the POST 404s, so neither the edge nor
      // the row exists and every read below 404s too.
      await postRel(alice.id, hrAdmin.id, { type: 'direct', targetId: bob.id });
    });

    it('T3a · current Reporting-line manager (Bob) → 200 { data: AccessJournalRow[] }, newest-first, no canEdit', async () => {
      const res = await getJournal(alice.id, bob.id);
      expect(res.status).toBe(200);
      const body = res.body as { data?: unknown[] } & Record<string, unknown>;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data?.length).toBeGreaterThan(0);
      expect(body).not.toHaveProperty('canEdit');
      const row = (body.data as Array<Record<string, unknown>>)[0];
      expect(Object.keys(row).sort()).toEqual(
        [
          'actorUserId',
          'after',
          'before',
          'id',
          'kind',
          'occurredAt',
          'subjectUserId',
        ].sort(),
      );
      expect(row.kind).toBe('manager');
      expect(row.subjectUserId).toBe(alice.id);
    });

    it('T3b · assigned People Partner (Paula) → 200 { data: [...] }', async () => {
      const res = await getJournal(alice.id, paula.id);
      expect(res.status).toBe(200);
      expect(Array.isArray((res.body as { data?: unknown[] }).data)).toBe(true);
    });

    it('T3c · Self (Alice) → 403 — not a §3.4 reader; leak-free body', async () => {
      const res = await getJournal(alice.id, alice.id);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('manager');
    });

    it('T3d · colleague / unrelated session (Eve) → 403', async () => {
      const res = await getJournal(alice.id, eve.id);
      expect(res.status).toBe(403);
    });

    it('T3e · HR Admin by functional role only → 403 — explicitly not a journal reader', async () => {
      const res = await getJournal(alice.id, hrAdmin.id);
      expect(res.status).toBe(403);
    });

    it('T3f · no / invalid token → 401', async () => {
      const res = await getJournal(alice.id);
      expect(res.status).toBe(401);
    });
  });
});
