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
 * Epic 4 — Organisational Relationships · Story 4.1 (Change an Employee's
 * Manager) + the `AccessJournal` foundation · AD-1 Stage 2, committed red.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-01-assign-reports-to.md
 *   um-rel-02-revoke-reports-to.md
 *   um-rel-03-second-reports-to-denied.md   (+ the §2.1 self-assignment negative)
 *   um-rel-07-non-hr-admin-denied.md         (Test 1 — reports-to; Tests 2/3 are the PP / dept files)
 *   um-rel-08-concurrent-reports-to-assign.md
 * The journal's own invariants + the read-authz matrix (`um-rel-15`) live in
 * `access-journal.e2e-spec.ts`.
 *
 * WHY RED (per test):
 *   - **red-because-route-missing** — `POST /users/:id/relationships` and
 *     `DELETE /users/:id/relationships/:relationshipId` (AD-14 shape 4) do not
 *     exist in `UserManagementModule` (`users.controller.ts` has no
 *     `relationships` handler), so every call 404s. Each assertion below is the
 *     real Story 4.1 target and starts passing the moment the story lands.
 *   - **red-because-model-missing** — the §3.4 `AccessJournal` table, its
 *     same-transaction writer, and the `GET /users/:id/access-journal` route are
 *     all absent (`schema.prisma` has no journal model). `queryAccessJournalRows`
 *     is `to_regclass`-guarded and returns `[]`, so "exactly one `manager`
 *     journal row committed in the same transaction" reads as a clean red
 *     (expected 1, got 0). PM/AD-29 ratified the design 2026-09-02 ("closes
 *     CC-07"); this story builds the implementation.
 *   - um-rel-02's "no manager access next request" is additionally
 *     **red-because-wrong-behaviour** until Epic 0 rebinds `ACCESS_CONTROL_PORT`
 *     to the real facade — the interim `isAllowedForTarget` returns `true` for
 *     any caller, so `GET /users/:id` is `200` regardless of the edge.
 *
 * SCOPE NOTE (premise correction). The Story 4.1 spec describes standing up the
 * `Relationship` Prisma model + its multi-armed CHECK / partial UNIQUE; on this
 * branch that model and every constraint already exist (Epic 0 migration
 * `20260830010000_access_control_relationships` — `relationships_one_direct_per_user`,
 * `relationships_no_self_endpoint_check`). So this suite reads the edge back
 * through the real `prisma.relationship` client (the model is present) and Story
 * 4.1's remaining deliverables are: the two write routes, the read route, the
 * `AccessJournal` table + enum + migration, and the same-transaction journal
 * writer.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown; `@concurrency` = parallel HTTP (`Promise.all`) in one test.
 * NFR-1: pseudonymised fixture data only.
 *
 * DEC-UM-005 (the reassignment residual): reports-to reassignment is explicit
 * `DELETE` then `POST`; a 2nd `POST` while a `direct` edge exists → `409`, never
 * an implicit replace — enforced by the DB partial `UNIQUE`
 * (`relationships_one_direct_per_user`), not an app pre-check. On the `409` the
 * whole transaction rolls back — no journal row. This suite always `DELETE`s
 * before re-`POST`ing.
 */
describe("Epic 4 · Story 4.1 — Change an Employee's Manager (e2e, committed red)", () => {
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
  // "access resolves through the new manager next request" — asserted as a
  // successful profile:identity read by the manager (a `direct` edge
  // `{ userId: report, reportsToUserId: manager }` makes `manager` resolve
  // `reporting` over `report`).
  const readAs = (targetId: string, viewerId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  // The write actor: a real user granted the (unseeded) FR-matrix key
  // `org:relationships:write` in-test. `um-rel-07` deliberately does NOT get it.
  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);
    return root;
  };

  const edgeSnapshot = (
    relationshipId: string | undefined,
    subordinateId: string,
    managerId: string,
  ) => ({
    relationshipId,
    userId: subordinateId,
    type: 'direct',
    reportsToUserId: managerId,
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

  // um-rel-01 -------------------------------------------------------------
  it('um-rel-01 · assign reports-to → 201, `direct` edge Alice→Bob, one same-tx `manager` journal row (before:null, after:edge)', async () => {
    const root = await seedActor('rel01-root');
    const alice = await fx.user('rel01-alice');
    const bob = await fx.user('rel01-bob');

    const res = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });

    expect(res.status).toBe(201);
    const relationshipId = (res.body as { id?: string }).id;
    expect(relationshipId).toBeTruthy();

    // Persisted fact (AD-11): exactly one `direct` row, Alice → Bob.
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'direct' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(bob.id);

    // Next request (§2.1 platform-owned; access-control.md "Revocation timing").
    const asBob = await readAs(alice.id, bob.id);
    expect(asBob.status).toBe(200);

    // §3.4 / PM/AD-29 — exactly one immutable journal row committed in the SAME
    // transaction as the edge write, visible on a plain committed read.
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'manager',
      actorUserId: root.id,
      subjectUserId: alice.id,
      before: null,
    });
    expect(journal[0]?.after).toMatchObject(
      edgeSnapshot(relationshipId, alice.id, bob.id),
    );
    expect(journal[0]?.occurredAt).toBeTruthy();
    expect(journal[0]?.idempotencyKey).toBeTruthy();
  });

  // um-rel-02 -------------------------------------------------------------
  it('um-rel-02 · revoke reports-to (hard delete) → 200, edge gone, one same-tx `manager` journal row (before:edge, after:null)', async () => {
    const root = await seedActor('rel02-root');
    const alice = await fx.user('rel02-alice');
    const bob = await fx.user('rel02-bob');

    // Precondition: the edge is created via um-rel-01's POST, and its response
    // `id` is the `<relationshipId>` the DELETE targets — never a hardcoded id.
    const created = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(created.status).toBe(201);
    const relationshipId = (created.body as { id?: string }).id;

    const journalBefore = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );

    const res = await deleteRel(alice.id, String(relationshipId), root.id);
    expect(res.status).toBe(200);

    // Row is hard-deleted (AD-11 — no `deletedAt`/`isActive`).
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'direct' },
    });
    expect(rows).toHaveLength(0);

    // Next request: Bob no longer resolves `reporting` over Alice. The original
    // draft asserted `403` here, but that contradicts the platform-wide
    // `colleague` floor (UMAC-04, `read-adoption.e2e-spec.ts`): two confirmed
    // active users always resolve at least `colleague`, and profile:identity is `R` for the
    // Colleague column, so `GET /users/:id` stays `200`. The real access
    // consequence of the revoke is that Bob drops from Reporting-line **writer**
    // to colleague — `canAccessSection('profile:identity')` goes `write` → `read` — so
    // `canEdit` flips to `false`. (Minimal Stage-3 fix — the `403` line was
    // unsatisfiable given the resolver's colleague floor.)
    const asBob = await readAs(alice.id, bob.id);
    expect(asBob.status).toBe(200);
    expect((asBob.body as { canEdit?: boolean }).canEdit).toBe(false);

    // §3.4 — a second `manager` journal row: the `before` snapshot is the only
    // surviving record of the hard-deleted edge; `after: null`.
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    // exactly one NEW row on top of the create's row.
    expect(journal).toHaveLength(journalBefore.length + 1);
    const deleteRow = journal[0]; // newest-first
    expect(deleteRow).toMatchObject({
      kind: 'manager',
      actorUserId: root.id,
      subjectUserId: alice.id,
      after: null,
    });
    expect(deleteRow?.before).toMatchObject(
      edgeSnapshot(relationshipId, alice.id, bob.id),
    );
  });

  // um-rel-03 -----------------------------------------------------------
  it('um-rel-03 · 2nd reports-to POST while a `direct` edge exists → 409 (DEC-UM-005); edge unchanged; journal row count unchanged (tx rollback)', async () => {
    const root = await seedActor('rel03-root');
    const alice = await fx.user('rel03-alice');
    const bob = await fx.user('rel03-bob');
    const paula = await fx.user('rel03-paula');

    const first = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(first.status).toBe(201);

    const journalBefore = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );

    const second = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: paula.id,
    });
    expect(second.status).toBe(409);

    // Alice's existing edge to Bob is unchanged.
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'direct' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(bob.id);

    // The `409` transaction rolls back whole — the journal INSERT is part of the
    // same aborted transaction, so no partial commit: count is unchanged.
    const journalAfter = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    expect(journalAfter).toHaveLength(journalBefore.length);
  });

  // um-rel-03-adjacent · §2.1 self-assignment negative ------------------
  it('um-rel-03 (self-assignment) · POST with targetId === :id → 400 (scenario-stage decision); no edge, no journal', async () => {
    const root = await seedActor('relself-root');
    const alice = await fx.user('relself-alice');

    const res = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: alice.id,
    });

    // Scenario-stage decision: self-assignment is pinned to `400` (the app guard
    // — `userId <> reportsToUserId`), NOT a `409` and NOT a `500` leaking the raw
    // DB CHECK `relationships_no_self_endpoint_check`. The spec allows "400 or
    // 409"; this suite asserts 400. If the gate lands as 409, flip this line and
    // the note travels with it.
    expect(res.status).toBe(400);

    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id },
    });
    expect(rows).toHaveLength(0);

    const journal = await queryAccessJournalRows(testApp.prisma, alice.id);
    expect(journal).toHaveLength(0);
  });

  // um-rel-07 (Test 1) ------------------------------------------------
  it('um-rel-07 · session lacking `org:relationships:write` → 403 (Ida, DEC-UM-002); no `Relationship`, no `AccessJournal`', async () => {
    // Ida holds a functional role whose only permission is unrelated
    // (`campaigns:create`) — the gate is the no-target
    // `isAllowed(viewer, 'org:relationships:write')` facade check, NOT an
    // `actor.position === 'HR Admin'` string check (AD-4).
    const ida = await fx.user('rel07-ida');
    await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
    const alice = await fx.user('rel07-alice');
    const bob = await fx.user('rel07-bob');

    const res = await postRel(alice.id, ida.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(res.status).toBe(403);

    // No relationship, no journal row (the denial short-circuits before the tx).
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id },
    });
    expect(rows).toHaveLength(0);

    const journal = await queryAccessJournalRows(testApp.prisma, alice.id);
    expect(journal).toHaveLength(0);
  });

  // um-rel-08 --------------------------------------------------------
  it('um-rel-08 · @concurrency — two parallel reports-to assigns → one 201 + one journal row, one 409 + no journal row, exactly one edge', async () => {
    const root = await seedActor('rel08-root');
    const alice = await fx.user('rel08-alice');
    const bob = await fx.user('rel08-bob');
    const paula = await fx.user('rel08-paula');

    // DEC-UM-010: parallel HTTP in one test, one worker.
    const [a, b] = await Promise.all([
      postRel(alice.id, root.id, { type: 'direct', targetId: bob.id }),
      postRel(alice.id, root.id, { type: 'direct', targetId: paula.id }),
    ]);

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);

    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'direct' },
    });
    expect(rows).toHaveLength(1);

    // The DB partial UNIQUE is the arbiter: the loser's whole transaction rolls
    // back, so exactly one `manager` journal row exists and its `after` snapshot
    // matches the surviving edge.
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'manager',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]?.after).toMatchObject({
      userId: alice.id,
      type: 'direct',
      reportsToUserId: rows[0]?.reportsToUserId,
    });
  });
});
