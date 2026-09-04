import request from 'supertest';
import {
  ORG_RELATIONSHIPS_WRITE_PERMISSION,
  RunFixtures,
  UNRELATED_PERMISSION,
  bearer,
  bootstrapTestApp,
  cleanupAccessJournal,
  queryAccessJournalRows,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · Story 4.2 (Change an Employee's
 * People Partner) — DELETE + the PP-change authorization matrix · AD-1 Stage 2,
 * committed red.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-16-pp-delete-and-authz.md   (T1 remove, T2 no-PP 404, T3 unauthorized PUT/DELETE, T4 wrong token)
 *   um-rel-07-non-hr-admin-denied.md   (Test 2 — PP change denied for a session lacking `org:relationships:write`)
 * The PUT create/replace happy + conflict paths live in
 * `people-partner-change.e2e-spec.ts`.
 *
 * Approved scenario-stage decisions encoded here (spec-4-2, um-rel-16):
 *   - `DELETE /users/:employeeId/relationships/people-partner` — the expected
 *     current PP is an OPTIONAL query parameter
 *     `?expectedCurrentTargetId=<ppId>` (api-conventions.md shape 4's `If-Match`
 *     has no ETag source; the architect reconciles the doc). Supplied +
 *     mismatched → `409`; omitted → the current PP is removed unconditionally.
 *   - `DELETE` on an assigned PP → `200` empty body; the `Relationship` row is
 *     HARD-deleted; one same-transaction `AccessJournal` row
 *     `kind:'people_partner'`, `before:` removed-edge snapshot, `after: null`.
 *   - `DELETE` with no PP assigned → `404`; no edge change, no journal row.
 *   - Unauthorized actor (Ida — holds an unrelated permission only; or Colin —
 *     a bare session) → `403` before any write on both `PUT` and `DELETE`; no
 *     edge change, no journal row. The gate is the no-target
 *     `isAllowed(viewer, 'org:relationships:write')` facade check, NOT an
 *     `actor.position === 'HR Admin'` string check (AD-4, DEC-UM-002).
 *
 * WHY RED (per test):
 *   - **red-because-route-missing** — there is no `PUT
 *     /users/:id/relationships/people-partner` handler and no dedicated
 *     `DELETE .../relationships/people-partner` handler in
 *     `RelationshipsController`. A `PUT` 404s outright. A `DELETE` on that path
 *     is instead swallowed by Story 4.1's generic
 *     `@Delete(':id/relationships/:relationshipId')` (relationshipId ==
 *     "people-partner"): with the write permission it reaches
 *     `RevokeManagerAction`, which 404s on the unknown relationship id; without
 *     it, the shared `@RequireFeature('org:relationships:write')` guard 403s
 *     first. Story 4.2 must add the static `people-partner` route ahead of the
 *     `:relationshipId` route. Every `expect(status).toBe(200|403|409)` and
 *     every "edge gone" / "one journal row" assertion is red because the seeded
 *     edge is left untouched and nothing is written.
 *   - T2 (`DELETE` on a subject with no PP → `404`) and T3b (Ida `DELETE` →
 *     `403`, denied at the shared guard) are GREEN today — a route-missing /
 *     wrong-route status coincides with the target status. Both are retained as
 *     real assertions that stay green once the dedicated route lands (T2 → the
 *     domain "no PP sub-resource" 404; T3b → the same no-target facade denial),
 *     with leak-free-body / no-edge / no-journal checks giving them teeth.
 *     Neither is a green→red risk.
 *
 * The Alice → Paula `people_partner` edge is a genuine precondition, seeded
 * directly via Prisma (`fx.peoplePartnerOf`) per nest-e2e.md and the Epic 0
 * partial unique index `relationships_one_people_partner_per_user`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown. One FR-granted actor per test (`RunFixtures.grantFunctionalRole`
 * targetRole-collision caveat).
 */
describe("Epic 4 · Story 4.2 — Remove / guard an Employee's People Partner (e2e, committed red)", () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();

  const putPp = (
    employeeId: string,
    viewerId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/users/${employeeId}/relationships/people-partner`)
      .set('authorization', bearer(viewerId))
      .send(body);

  const deletePp = (
    employeeId: string,
    viewerId: string,
    expectedCurrentTargetId?: string,
  ) => {
    const path = `/users/${employeeId}/relationships/people-partner`;
    const url = expectedCurrentTargetId
      ? `${path}?expectedCurrentTargetId=${expectedCurrentTargetId}`
      : path;
    return request(server()).delete(url).set('authorization', bearer(viewerId));
  };

  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);
    return root;
  };

  const ppRows = (employeeId: string) =>
    testApp.prisma.relationship.findMany({
      where: { userId: employeeId, type: 'people_partner' },
    });

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

  // um-rel-16 Test 1 ------------------------------------------------
  it('um-rel-16 T1 · DELETE an assigned PP → 200 empty body, edge hard-deleted, one same-tx journal row (before: Paula edge, after: null)', async () => {
    const root = await seedActor('rel16t1-root');
    const alice = await fx.user('rel16t1-alice');
    const paula = await fx.user('rel16t1-paula');
    await fx.peoplePartnerOf(alice.id, paula.id);
    const seededEdge = await testApp.prisma.relationship.findFirst({
      where: { userId: alice.id, type: 'people_partner' },
    });

    const res = await deletePp(alice.id, root.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    // Hard delete (AD-11 — no `deletedAt`/`isActive` on `Relationship`).
    expect(await ppRows(alice.id)).toHaveLength(0);

    // §3.4 — one `people_partner` journal row committed in the same
    // transaction; the `before` snapshot is the only surviving record of the
    // removed edge.
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'people_partner',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'people_partner',
      actorUserId: root.id,
      subjectUserId: alice.id,
      after: null,
    });
    expect(journal[0]?.before).toMatchObject({
      relationshipId: seededEdge?.id,
      userId: alice.id,
      type: 'people_partner',
      reportsToUserId: paula.id,
    });
    expect(journal[0]?.occurredAt).toBeTruthy();
  });

  // um-rel-16 Test 2 ------------------------------------------------
  it('um-rel-16 T2 · DELETE when no PP is assigned → 404, leak-free body, no journal row', async () => {
    const root = await seedActor('rel16t2-root');
    const nina = await fx.user('rel16t2-nina');
    expect(await ppRows(nina.id)).toHaveLength(0);

    const res = await deletePp(nina.id, root.id);
    // NOTE: green today — a route-missing 404 coincides with the target 404.
    // Stays green once the route lands (domain "no PP sub-resource" 404).
    expect(res.status).toBe(404);
    // Teeth: the body never carries subject PII.
    const serialized = JSON.stringify(res.body ?? {});
    expect(serialized).not.toContain(nina.workEmail);
    expect(serialized).not.toContain(nina.lastName);

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      nina.id,
      'people_partner',
    );
    expect(journal).toHaveLength(0);
  });

  // um-rel-16 Test 3 + um-rel-07 Test 2 ---------------------------
  describe('unauthorized actor → 403 on PUT and DELETE, no edge change, no journal row', () => {
    it('um-rel-16 T3a · Ida (unrelated permission only) PUT → 403', async () => {
      const ida = await fx.user('rel16t3a-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
      const alice = await fx.user('rel16t3a-alice');
      const paula = await fx.user('rel16t3a-paula');
      const nina = await fx.user('rel16t3a-nina');
      await fx.peoplePartnerOf(alice.id, paula.id);

      const res = await putPp(alice.id, ida.id, {
        targetId: nina.id,
        expectedCurrentTargetId: paula.id,
      });
      expect(res.status).toBe(403);

      const rows = await ppRows(alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reportsToUserId).toBe(paula.id);
      expect(
        await queryAccessJournalRows(
          testApp.prisma,
          alice.id,
          'people_partner',
        ),
      ).toHaveLength(0);
    });

    it('um-rel-16 T3b · Ida (unrelated permission only) DELETE → 403', async () => {
      const ida = await fx.user('rel16t3b-ida');
      await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
      const alice = await fx.user('rel16t3b-alice');
      const paula = await fx.user('rel16t3b-paula');
      await fx.peoplePartnerOf(alice.id, paula.id);

      const res = await deletePp(alice.id, ida.id);
      // Green today: short-circuits at Story 4.1's shared
      // `@RequireFeature('org:relationships:write')` guard on the generic
      // `:relationshipId` route. Same 403 (same no-target facade denial) once
      // the dedicated `people-partner` DELETE route lands.
      expect(res.status).toBe(403);

      const rows = await ppRows(alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reportsToUserId).toBe(paula.id);
      expect(
        await queryAccessJournalRows(
          testApp.prisma,
          alice.id,
          'people_partner',
        ),
      ).toHaveLength(0);
    });

    it('um-rel-07 T2 · Colin (bare session, no functional role) PUT → 403', async () => {
      const colin = await fx.user('rel07t2-colin');
      const alice = await fx.user('rel07t2-alice');
      const paula = await fx.user('rel07t2-paula');
      const nina = await fx.user('rel07t2-nina');
      await fx.peoplePartnerOf(alice.id, paula.id);

      const res = await putPp(alice.id, colin.id, {
        targetId: nina.id,
        expectedCurrentTargetId: paula.id,
      });
      expect(res.status).toBe(403);

      const rows = await ppRows(alice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reportsToUserId).toBe(paula.id);
      expect(
        await queryAccessJournalRows(
          testApp.prisma,
          alice.id,
          'people_partner',
        ),
      ).toHaveLength(0);
    });
  });

  // um-rel-16 — DELETE optimistic-concurrency token guard --------
  // (the scenario-stage decision in um-rel-16's header: supplied + mismatched
  // query param → 409; not the doc's numbered "Test 4", which is the
  // audience-on-next-request case covered by um-rel-09 A.)
  it('um-rel-16 · DELETE ?expectedCurrentTargetId=<wrong> → 409, PP unchanged, no journal row', async () => {
    const root = await seedActor('rel16t4-root');
    const alice = await fx.user('rel16t4-alice');
    const paula = await fx.user('rel16t4-paula');
    const mira = await fx.user('rel16t4-mira');
    await fx.peoplePartnerOf(alice.id, paula.id);

    // Supplied and does NOT match the current PP (Paula) → conditional remove fails.
    const res = await deletePp(alice.id, root.id, mira.id);
    expect(res.status).toBe(409);

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(paula.id);
    expect(
      await queryAccessJournalRows(testApp.prisma, alice.id, 'people_partner'),
    ).toHaveLength(0);
  });
});
