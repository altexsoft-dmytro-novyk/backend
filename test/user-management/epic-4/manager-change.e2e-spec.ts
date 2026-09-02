import request from 'supertest';
import {
  CHANGE_ORG_RELATIONSHIPS_PERMISSION,
  RunFixtures,
  UNRELATED_PERMISSION,
  bearer,
  bootstrapTestApp,
  relationshipJournalTable,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · Story 4.1 (Change an Employee's
 * Manager) · AD-1 Stage 2, committed red.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-01-assign-reports-to.md
 *   um-rel-02-revoke-reports-to.md
 *   um-rel-03-second-reports-to-denied.md
 *   um-rel-07-non-hr-admin-denied.md          (Test 1 — reports-to; Tests 2/3 live in the PP / dept files)
 *   um-rel-08-concurrent-reports-to-assign.md
 *   + the §2.1 cross-cutting self-assignment-rejected negative
 *
 * WHY RED (per test):
 *   - um-rel-01/02/03/07/08 + self-assignment: **red-because-route-missing** —
 *     `POST /users/:id/relationships` and `DELETE
 *     /users/:id/relationships/:relationshipId` (AD-14 shape 4) are not
 *     implemented in `UserManagementModule` (no relationships controller /
 *     action exists), so every call 404s. Each assertion below is the real
 *     target behaviour and starts passing the moment Story 4.1 lands.
 *   - The layered §3.4 journal `expect` in um-rel-01/02 is additionally
 *     **red-because-model-missing** — CC-07 (AD-19 Journal gate) is unapproved,
 *     there is no journal table (`relationshipJournalTable` → `null`). Annotated
 *     `// CC-07` so the test documents the full atomic-journal target.
 *   - The "no manager access next request" assertion in um-rel-02 is
 *     additionally **red-because-wrong-behaviour** until Epic 0 rebinds
 *     `ACCESS_CONTROL_PORT` to the real facade — the interim
 *     `isAllowedForTarget` returns `true` for any caller, so `GET /users/:id`
 *     is `200` regardless of the edge. Annotated inline.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown; `@concurrency` = parallel HTTP (`Promise.all`) in one test.
 * NFR-1: pseudonymised fixture data only.
 *
 * DEC-UM-005 (the reassignment residual): reports-to reassignment is explicit
 * `DELETE` then `POST`; a 2nd `POST` while a `direct` edge exists → `409`, never
 * an implicit replace — enforced by the DB partial `UNIQUE`
 * (`relationships_one_direct_per_user`), not an app pre-check. Accepted
 * residual: a failed `POST` after a successful `DELETE` may leave the employee
 * temporarily manager-less. This suite always `DELETE`s before re-`POST`ing.
 */
describe("Epic 4 · Story 4.1 — Change an Employee's Manager (e2e, committed red)", () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();
  const postRel = (employeeId: string, viewerId: string, body: unknown) =>
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
  // successful S1 read by the manager (Epic 0 `read-adoption` fixture
  // direction: a `direct` edge `{ userId: report, reportsToUserId: manager }`
  // makes `manager` resolve `reporting` over `report`).
  const readAs = (targetId: string, viewerId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [
      CHANGE_ORG_RELATIONSHIPS_PERMISSION,
    ]);
    return root;
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

  // um-rel-01 -------------------------------------------------------------
  it('um-rel-01 · assign reports-to → 201, `direct` edge Alice→Bob, Bob resolves reporting next request', async () => {
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

    // CC-07: journal row assertion — red until CC-07 schema lands.
    // AD-19 §3.4 target: exactly one immutable before/after row
    // { actor: Root, subject: Alice, before: <none>, after: Bob } committed in
    // the SAME transaction as the edge write. `UserEvents` is not a substitute.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-02 -------------------------------------------------------------
  it('um-rel-02 · revoke reports-to (hard delete) → 200, edge gone, no manager access next request', async () => {
    const root = await seedActor('rel02-root');
    const alice = await fx.user('rel02-alice');
    const bob = await fx.user('rel02-bob');

    // Precondition per the doc: the edge is created via um-rel-01's POST, and
    // its response `id` is the `<relationshipId>` the DELETE targets — never a
    // hardcoded id (nest-e2e.md#preconditions-must-be-real-not-assumed).
    const created = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(created.status).toBe(201);
    const relationshipId = (created.body as { id: string }).id;

    const res = await deleteRel(alice.id, relationshipId, root.id);
    expect(res.status).toBe(200);

    // Row is hard-deleted (AD-11 — no `deletedAt`/`isActive`).
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'direct' },
    });
    expect(rows).toHaveLength(0);

    // Next request: Bob no longer resolves `reporting` over Alice.
    // red-because-wrong-behaviour until Epic 0 rebinds ACCESS_CONTROL_PORT to
    // the real facade — the interim `isAllowedForTarget` returns `true` for any
    // caller, so this is `200` today.
    const asBob = await readAs(alice.id, bob.id);
    expect(asBob.status).toBe(403);

    // CC-07: journal row assertion — red until CC-07 schema lands.
    // AD-19 §3.4 target: one before/after row { before: Bob, after: <none> }.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-03 -------------------------------------------------------------
  it('um-rel-03 · 2nd reports-to POST while a `direct` edge exists → 409 (DEC-UM-005, no implicit replace)', async () => {
    const root = await seedActor('rel03-root');
    const alice = await fx.user('rel03-alice');
    const bob = await fx.user('rel03-bob');
    const paula = await fx.user('rel03-paula');

    const first = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(first.status).toBe(201);

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
  });

  // um-rel-07 (Test 1) --------------------------------------------------
  it('um-rel-07 · session lacking the change-organisational-relationships permission → 403 (Ida, DEC-UM-002)', async () => {
    // Ida holds an unrelated functional role — the gate is the no-target
    // `isAllowed(viewer, "change organisational relationships")` facade check,
    // NOT an `actor.position === 'HR Admin'` string check (AD-4).
    const ida = await fx.user('rel07-ida');
    await fx.grantFunctionalRole(ida.id, [UNRELATED_PERMISSION]);
    const alice = await fx.user('rel07-alice');
    const bob = await fx.user('rel07-bob');

    const res = await postRel(alice.id, ida.id, {
      type: 'direct',
      targetId: bob.id,
    });
    expect(res.status).toBe(403);

    // No relationship (nor journal, nor career-event) row is written.
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id },
    });
    expect(rows).toHaveLength(0);
  });

  // um-rel-08 ----------------------------------------------------------
  it('um-rel-08 · @concurrency — two parallel reports-to assigns → one 201, one 409, exactly one edge', async () => {
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
  });

  // §2.1 cross-cutting self-assignment negative ------------------------
  it('self-assignment · POST with targetId === :id is rejected, no edge, no journal (§2.1)', async () => {
    const root = await seedActor('relself-root');
    const alice = await fx.user('relself-alice');

    const res = await postRel(alice.id, root.id, {
      type: 'direct',
      targetId: alice.id,
    });

    // Rejected as a bad request / conflict — NOT a 404 (route missing) and NOT
    // a 500 (raw DB CHECK `relationships_no_self_endpoint_check` leaking).
    expect([400, 409, 422]).toContain(res.status);

    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id },
    });
    expect(rows).toHaveLength(0);

    // CC-07: once the journal table lands this asserts ZERO before/after rows
    // for Alice — a rejected mutation writes no journal. Today the table is
    // absent, so the check is red-because-model-missing.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });
});
