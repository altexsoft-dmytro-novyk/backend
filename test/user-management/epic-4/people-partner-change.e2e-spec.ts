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
 * Epic 4 — Organisational Relationships · Story 4.2 (Change an Employee's
 * People Partner) · AD-1 Stage 2, committed red.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-09-pp-atomic-replace.md          (Test A replace, Test B first assignment)
 *   um-rel-10-pp-self-assignment-rejected.md
 *   um-rel-11-pp-stale-expected-target-409.md (T1 stale, T2 @concurrency, T3 omitted token)
 * DELETE + the authz / audience matrix (`um-rel-16`, `um-rel-07` T2) live in
 * `pp-delete.e2e-spec.ts`.
 *
 * RECONCILED 2026-09-03 to the Story 4.2 stage-2 reconciliation (README +
 * spec-4-2). The old "BLOCKED — CC-04 + CC-07; scenario prose only" framing is
 * removed: CC-07 / PM/AD-29 (`AccessJournal`) was built by Story 4.1 (table,
 * `AccessJournalKind` enum incl. `people_partner`, same-transaction writer,
 * `GET /users/:id/access-journal`); CC-04 is design-resolved (`P2`, "Not a
 * design blocker on PM/AD-19"). The `people_partner` journal assertions are now
 * first-class — the table exists, so `queryAccessJournalRows` runs and returns
 * `[]` (nothing written, because the route 404s), which is a clean red
 * ("expected 1 journal row, got 0"), never a crash.
 *
 * Approved scenario-stage decisions encoded here (spec-4-2 §"Scenario-stage
 * decisions", I/O matrix):
 *   - `PUT /users/:employeeId/relationships/people-partner`
 *     `{ targetId, expectedCurrentTargetId? }` → `200` with the bare
 *     relationship `{ id, userId, type:'people_partner', reportsToUserId }` for
 *     BOTH create and replace. Gate `@RequireFeature('org:relationships:write')`.
 *   - `PUT` with a PP already assigned and NO `expectedCurrentTargetId` → `409`
 *     (a replace must acknowledge what it replaces). First assignment (no
 *     current PP) with the token omitted → `200`, creates the edge.
 *   - Self-assignment (`employeeId === targetId`) → `400` (app-level pre-check
 *     before the transaction opens; the `userId <> reportsToUserId` CHECK is the
 *     backstop). DEC-UM + spec-4-2 I/O matrix pin this to `400`, not `409`.
 *   - Stale `expectedCurrentTargetId` → `409`, state unchanged, no journal row.
 *   - Every `PUT` (create or replace) writes exactly one `AccessJournal` row
 *     `kind:'people_partner'` in the SAME transaction — create → `before:null`,
 *     replace → `before:` old PP-edge snapshot, `after:` new PP-edge snapshot.
 *     On `400`/`409` the transaction rolls back → no journal row.
 *   - @concurrency (DEC-UM-010): two parallel replaces from one baseline →
 *     exactly one `200` + one journal row, the other `409` + none.
 *
 * WHY RED (per test):
 *   - all: **red-because-route-missing** — `PUT
 *     /users/:employeeId/relationships/people-partner` is not implemented in
 *     `UserManagementModule` (`users.controller.ts` has no `people-partner`
 *     handler), so every call 404s. Each `expect(status).toBe(200|400|409)` and
 *     each `expect(journal).toHaveLength(1)` / edge-moved assertion is red
 *     because the 404 leaves the seeded edge untouched and writes nothing.
 *   - um-rel-09 A's "new PP's access resolves next request" (`canEdit === true`
 *     for Nina) is additionally red until the S1 `{ data, canEdit }` envelope
 *     ships (UMAC-1 production) — the route 404 keeps Alice's PP = Paula, so
 *     Nina never gains the `pp` audience.
 *
 * The Alice → Paula / Alice → Nina `people_partner` edge is a genuine
 * precondition (not the id under test — the PP command is keyed by employee, not
 * by relationship id), so it is seeded directly via Prisma (`fx.peoplePartnerOf`)
 * per the nest-e2e.md precondition rule and the Epic 0 partial unique index
 * `relationships_one_people_partner_per_user`.
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown; `@concurrency` = parallel HTTP (`Promise.all`) in one test.
 * The `RunFixtures.grantFunctionalRole` targetRole-collision caveat: one
 * FR-granted actor per test (each `it` calls `seedActor` once).
 */
describe("Epic 4 · Story 4.2 — Change an Employee's People Partner (e2e, committed red)", () => {
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

  // "the new PP's access resolves on the next request" — asserted as an S1 read
  // by the would-be PP: an assigned `people_partner` edge
  // `{ userId: employee, reportsToUserId: pp }` makes `pp` resolve the `pp`
  // audience (S1 `write`) over `employee`, so `canEdit` is `true`.
  const readAs = (targetId: string, viewerId: string) =>
    request(server())
      .get(`/users/${targetId}`)
      .set('authorization', bearer(viewerId));

  // The write actor: a real user granted the (unseeded) FR-matrix key
  // `org:relationships:write` in-test — the `@RequireFeature` gate resolves
  // through the real facade's no-target `isAllowed`, never a role-name check.
  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);
    return root;
  };

  const ppRows = (employeeId: string) =>
    testApp.prisma.relationship.findMany({
      where: { userId: employeeId, type: 'people_partner' },
    });

  const ppEdgeSnapshot = (
    relationshipId: string | undefined,
    employeeId: string,
    ppId: string,
  ) => ({
    relationshipId,
    userId: employeeId,
    type: 'people_partner',
    reportsToUserId: ppId,
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

  // um-rel-09 Test A ---------------------------------------------------
  it('um-rel-09 A · atomic replace Paula→Nina → 200, single `people_partner` edge now Nina, one same-tx journal row (before: Paula, after: Nina), Nina resolves `pp` next request', async () => {
    const root = await seedActor('rel09a-root');
    const alice = await fx.user('rel09a-alice');
    const paula = await fx.user('rel09a-paula');
    const nina = await fx.user('rel09a-nina');
    await fx.peoplePartnerOf(alice.id, paula.id); // precondition
    const seededEdge = await testApp.prisma.relationship.findFirst({
      where: { userId: alice.id, type: 'people_partner' },
    });

    const res = await putPp(alice.id, root.id, {
      targetId: nina.id,
      expectedCurrentTargetId: paula.id,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: alice.id,
      type: 'people_partner',
      reportsToUserId: nina.id,
    });

    // Fixed-cardinality PP edge is atomically replaced — still exactly one
    // `people_partner` row, now pointing at Nina; the row is REPLACED (old row
    // hard-deleted, new row created), so its `id` changes (um-rel-09 stateChange).
    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(nina.id);
    expect(rows[0]?.id).not.toBe(seededEdge?.id);

    // §3.4 / PM/AD-29 — exactly one immutable journal row committed in the SAME
    // transaction as the edge replace, visible on a plain committed read.
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
    });
    expect(journal[0]?.before).toMatchObject(
      ppEdgeSnapshot(seededEdge?.id, alice.id, paula.id),
    );
    expect(journal[0]?.after).toMatchObject(
      ppEdgeSnapshot(rows[0]?.id, alice.id, nina.id),
    );
    expect(journal[0]?.occurredAt).toBeTruthy();
    expect(journal[0]?.idempotencyKey).toBeTruthy();

    // Next request (§2.1 platform-owned): Nina — Alice's new directly-assigned
    // PP — resolves the `pp` audience over Alice (S1 `write` → `canEdit: true`);
    // Paula's PP-level access is gone.
    const ninaView = await readAs(alice.id, nina.id);
    expect(ninaView.status).toBe(200);
    expect((ninaView.body as { canEdit?: boolean }).canEdit).toBe(true);

    const paulaView = await readAs(alice.id, paula.id);
    if (paulaView.status === 200) {
      // colleague floor retained — but the PP-level `write` is gone.
      expect((paulaView.body as { canEdit?: boolean }).canEdit).toBe(false);
    } else {
      expect(paulaView.status).toBe(403);
    }
  });

  // um-rel-09 Test B ---------------------------------------------------
  it('um-rel-09 B · first assignment (Alice has no PP), `PUT { targetId: Paula }` (token omitted) → 200, edge created, one same-tx journal row (before: null, after: edge)', async () => {
    const root = await seedActor('rel09b-root');
    const alice = await fx.user('rel09b-alice');
    const paula = await fx.user('rel09b-paula');
    // Precondition: Alice has NO `people_partner` edge.
    expect(await ppRows(alice.id)).toHaveLength(0);

    const res = await putPp(alice.id, root.id, { targetId: paula.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: alice.id,
      type: 'people_partner',
      reportsToUserId: paula.id,
    });

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(paula.id);

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
      before: null,
    });
    expect(journal[0]?.after).toMatchObject(
      ppEdgeSnapshot(rows[0]?.id, alice.id, paula.id),
    );
  });

  // um-rel-10 --------------------------------------------------------
  it('um-rel-10 · self-assignment (`targetId === employeeId`) → 400 before the tx opens, current PP (Paula) unchanged, no journal row', async () => {
    const root = await seedActor('rel10-root');
    const alice = await fx.user('rel10-alice');
    const paula = await fx.user('rel10-paula');
    await fx.peoplePartnerOf(alice.id, paula.id);

    // DEC-UM + spec-4-2 I/O matrix: `employeeId === targetId` is the pinned
    // self-assignment case (the scenario doc frames it via the Root persona;
    // the invariant under test is subject == target). Pinned to `400`, never
    // `409`, never a raw `500` leaking `relationships_no_self_endpoint_check`.
    const res = await putPp(alice.id, root.id, {
      targetId: alice.id,
      expectedCurrentTargetId: paula.id,
    });
    expect(res.status).toBe(400);

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(paula.id);

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'people_partner',
    );
    expect(journal).toHaveLength(0);
  });

  // um-rel-11 Test 1 ------------------------------------------------
  it('um-rel-11 T1 · stale `expectedCurrentTargetId` (names Paula, current is Nina) → 409, PP stays Nina, no journal row (tx rollback)', async () => {
    const root = await seedActor('rel11t1-root');
    const alice = await fx.user('rel11t1-alice');
    const paula = await fx.user('rel11t1-paula');
    const nina = await fx.user('rel11t1-nina');
    const mira = await fx.user('rel11t1-mira');
    // Precondition: Alice's PP is currently Nina (the doc's "changed from Paula
    // to Nina by a prior request"); the observable precondition is "PP = Nina",
    // seeded directly.
    await fx.peoplePartnerOf(alice.id, nina.id);

    const res = await putPp(alice.id, root.id, {
      targetId: mira.id,
      expectedCurrentTargetId: paula.id, // stale — current PP is Nina
    });
    expect(res.status).toBe(409);

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(nina.id);

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'people_partner',
    );
    expect(journal).toHaveLength(0);
  });

  // um-rel-11 Test 2 ------------------------------------------------
  it('um-rel-11 T2 · @concurrency — two parallel replaces from one baseline → [200, 409], exactly one edge, exactly one journal row', async () => {
    const root = await seedActor('rel11t2-root');
    const alice = await fx.user('rel11t2-alice');
    const nina = await fx.user('rel11t2-nina');
    const paula = await fx.user('rel11t2-paula');
    const mira = await fx.user('rel11t2-mira');
    await fx.peoplePartnerOf(alice.id, nina.id); // shared baseline

    // DEC-UM-010: parallel HTTP in one test, both predicating on the same
    // baseline (`expectedCurrentTargetId: nina`), different targets.
    const [a, b] = await Promise.all([
      putPp(alice.id, root.id, {
        targetId: paula.id,
        expectedCurrentTargetId: nina.id,
      }),
      putPp(alice.id, root.id, {
        targetId: mira.id,
        expectedCurrentTargetId: nina.id,
      }),
    ]);

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);

    // Exactly ONE new `people_partner` journal row — the loser's whole
    // transaction rolls back (its replace predicate no longer matches once the
    // winner commits); never two edge writes, never two journal rows (AD-19).
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'people_partner',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]?.after).toMatchObject({
      userId: alice.id,
      type: 'people_partner',
      reportsToUserId: rows[0]?.reportsToUserId,
    });
  });

  // um-rel-11 Test 3 ------------------------------------------------
  it('um-rel-11 T3 · PP already assigned, `PUT` with `expectedCurrentTargetId` omitted → 409 (blind replace refused), PP stays Paula, no journal row', async () => {
    const root = await seedActor('rel11t3-root');
    const alice = await fx.user('rel11t3-alice');
    const paula = await fx.user('rel11t3-paula');
    const nina = await fx.user('rel11t3-nina');
    await fx.peoplePartnerOf(alice.id, paula.id);

    const res = await putPp(alice.id, root.id, { targetId: nina.id });
    expect(res.status).toBe(409);

    const rows = await ppRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(paula.id);

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'people_partner',
    );
    expect(journal).toHaveLength(0);
  });
});
