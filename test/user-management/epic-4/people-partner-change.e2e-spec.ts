import request from 'supertest';
import {
  CHANGE_ORG_RELATIONSHIPS_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  relationshipJournalTable,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · Story 4.2 (Change an Employee's
 * People Partner) · AD-1 Stage 2.
 *
 * BLOCKED — CC-04 (PP persistence / cardinality / write contract) + CC-07
 * (AD-19 immutable before/after journal) not approved; route shape from
 * `api-conventions.md` shape 4 (`PUT /users/:id/relationships/people-partner
 * {targetId, expectedCurrentTargetId}`) + AD-19. These are written as real
 * `it()` asserting the target route behaviour — they 404 today (committed red)
 * — but the exact success status/body, the stale-token status, and every
 * journal assertion may need revision when CC-04/CC-07 land. Do NOT treat a
 * green here as acceptance of Story 4.2 before its gates clear.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-09-pp-atomic-replace.md
 *   um-rel-10-pp-self-assignment-rejected.md
 *   um-rel-11-pp-stale-expected-target-409.md
 *
 * WHY RED (per test):
 *   - all: **red-because-route-missing** — `PUT
 *     /users/:id/relationships/people-partner` is not implemented in
 *     `UserManagementModule`; every call 404s.
 *   - additionally **BLOCKED-contract-undefined** — the assertions encode
 *     `api-conventions.md` + AD-19 prose, not an approved CC-04/CC-07 contract.
 *   - the journal `expect`s are additionally **red-because-model-missing**
 *     (no journal table on `dn-um-2`).
 *   - the "old PP loses / new PP gains access next request" assertions are
 *     additionally **red-because-wrong-behaviour** until Epic 0 rebinds
 *     `ACCESS_CONTROL_PORT` to the real facade (interim `isAllowedForTarget`
 *     is always `true`).
 *
 * The Alice→Paula / Alice→Nina `people_partner` edge is a genuine precondition
 * (not the id under test — the PP command is keyed by employee, not by
 * relationship id), so it is seeded directly via Prisma per HARD RULE 4 and the
 * AD-11 partial unique index `relationships_one_people_partner_per_user`.
 *
 * AD-3: real `AppModule`, real Prisma, NO `overrideProvider`. DEC-UM-010: one
 * worker, run-namespaced data, `@concurrency` = `Promise.all` in one test.
 */
describe('Epic 4 · Story 4.2 — Change an Employee\'s People Partner (e2e, committed red — BLOCKED CC-04 + CC-07)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();
  const putPp = (employeeId: string, viewerId: string, body: unknown) =>
    request(server())
      .put(`/users/${employeeId}/relationships/people-partner`)
      .set('authorization', bearer(viewerId))
      .send(body);
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

  // um-rel-09 -----------------------------------------------------------
  it('um-rel-09 · atomic PP replace Paula→Nina → 200, single people_partner edge now Nina, PP access flips next request', async () => {
    const root = await seedActor('rel09-root');
    const alice = await fx.user('rel09-alice');
    const paula = await fx.user('rel09-paula');
    const nina = await fx.user('rel09-nina');
    await fx.peoplePartnerOf(alice.id, paula.id); // precondition

    const res = await putPp(alice.id, root.id, {
      targetId: nina.id,
      expectedCurrentTargetId: paula.id,
    });
    // BLOCKED: exact success status/body owned by CC-04.
    expect(res.status).toBe(200);

    // Fact: the fixed-cardinality PP edge is atomically replaced — still
    // exactly one `people_partner` row, now pointing at Nina (AD-11 /AD-19).
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'people_partner' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(nina.id);

    // Next request (§2.1 platform-owned): Nina resolves `pp` over Alice, Paula
    // does not. red-because-wrong-behaviour until the Epic 0 facade rebind.
    expect((await readAs(alice.id, nina.id)).status).toBe(200);
    expect((await readAs(alice.id, paula.id)).status).toBe(403);

    // CC-07: journal row assertion — red until CC-07 schema lands. AD-19 §3.4
    // target: exactly one immutable before/after row
    // { actor: Root, subject: Alice, before: Paula, after: Nina }, SAME
    // transaction as the edge replacement.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-10 -----------------------------------------------------------
  it('um-rel-10 · Root naming itself as Alice\'s PP is rejected, Paula unchanged, no journal', async () => {
    const root = await seedActor('rel10-root');
    const alice = await fx.user('rel10-alice');
    const paula = await fx.user('rel10-paula');
    await fx.peoplePartnerOf(alice.id, paula.id);

    const res = await putPp(alice.id, root.id, {
      targetId: root.id, // self-assignment: actor names itself (um-rel-10)
      expectedCurrentTargetId: paula.id,
    });
    // BLOCKED: exact status (400 vs 409) owned by CC-04 — but never 404 / 500.
    expect([400, 409, 422]).toContain(res.status);

    // Current PP (Paula) is unchanged.
    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'people_partner' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(paula.id);

    // CC-07: once the table lands this asserts ZERO before/after rows for Alice.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-11 Test 1 --------------------------------------------------
  it('um-rel-11 Test 1 · stale expectedCurrentTargetId on the PP replace → 409, PP stays Nina, no journal', async () => {
    const root = await seedActor('rel11-root');
    const alice = await fx.user('rel11-alice');
    const paula = await fx.user('rel11-paula');
    const nina = await fx.user('rel11-nina');
    const mira = await fx.user('rel11-mira');
    // Precondition: Alice's PP is currently Nina (the doc's "changed from Paula
    // to Nina by a prior request"). The observable precondition is "PP = Nina";
    // seeded directly per HARD RULE 4.
    await fx.peoplePartnerOf(alice.id, nina.id);

    const res = await putPp(alice.id, root.id, {
      targetId: mira.id,
      expectedCurrentTargetId: paula.id, // stale — names Paula, current is Nina
    });
    expect(res.status).toBe(409);

    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'people_partner' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reportsToUserId).toBe(nina.id);

    // CC-07: once the table lands this asserts ZERO before/after rows for Alice.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-11 Test 2 --------------------------------------------------
  it('um-rel-11 Test 2 · @concurrency — two parallel PP replaces from one baseline → one 200, one 409, one edge, one journal row', async () => {
    const root = await seedActor('rel11c-root');
    const alice = await fx.user('rel11c-alice');
    const nina = await fx.user('rel11c-nina');
    const paula = await fx.user('rel11c-paula');
    const mira = await fx.user('rel11c-mira');
    await fx.peoplePartnerOf(alice.id, nina.id); // shared baseline

    // DEC-UM-010: parallel HTTP in one test, both predicating on the same
    // baseline (expectedCurrentTargetId: Nina), different targets.
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

    const rows = await testApp.prisma.relationship.findMany({
      where: { userId: alice.id, type: 'people_partner' },
    });
    expect(rows).toHaveLength(1);

    // CC-07: exactly ONE before/after journal record — never two edge writes,
    // never two journal rows (AD-19). Red until CC-07 schema lands.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });
});
