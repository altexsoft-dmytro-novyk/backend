import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import {
  CHANGE_ORG_RELATIONSHIPS_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  relationshipJournalTable,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · Story 4.3 (Change Employee Department
 * or Department Manager) · AD-1 Stage 2.
 *
 * BLOCKED — CC-07 (AD-19 journal) + the Department edge contract (spine
 * Deferred: the nested-department entity, exactly-one membership, the
 * department-manager access walk, the HR root/boundary) are not approved.
 * Route shape is the current placeholder from `api-conventions.md` shape 4
 * (`POST /users/:id/policies {type:'AR', targetType:'department', targetId,
 * targetRole}`) — `targetType:'department'` is "accepted by the schema but not
 * yet honored by tier resolution" (fail-closed, AD-10/AD-12). These are real
 * `it()` asserting the target behaviour; they 404 today (committed red). Every
 * assertion — including the route/body itself — may need revision when the
 * Department edge contract lands.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-12-change-department.md
 *   um-rel-13-change-department-manager.md
 *   um-rel-14-department-self-assignment-rejected.md
 *
 * WHY RED (per test):
 *   - all: **red-because-route-missing** — no `POST /users/:id/policies`
 *     controller exists in `UserManagementModule`; every call 404s.
 *   - additionally **BLOCKED-contract-undefined** — no Department entity, no
 *     membership seam, no department-manager walk. `<deptB-id>` is a generated
 *     placeholder: no request in this suite (or any) can produce a real one
 *     until the Department edge contract lands (nest-e2e.md allows the closest
 *     substitute for a precondition with no HTTP-observable seam).
 *   - the journal `expect`s: **red-because-model-missing** (no journal table).
 *   - the "manager resolves reporting next request" assertions: additionally
 *     **red-because-wrong-behaviour** — `department`-targeted rows contribute
 *     nothing to tier resolution today (fail-closed), and the interim
 *     `isAllowedForTarget` is always `true` until the Epic 0 facade rebind.
 *
 * AD-3: real `AppModule`, real Prisma, NO `overrideProvider`. DEC-UM-010: one
 * worker, run-namespaced data. NFR-1: pseudonymised fixture data only.
 */
describe('Epic 4 · Story 4.3 — Change Employee Department / Department Manager (e2e, committed red — BLOCKED CC-07 + Department edge contract)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;

  const server = () => testApp.app.getHttpServer();
  const postPolicy = (userId: string, viewerId: string, body: unknown) =>
    request(server())
      .post(`/users/${userId}/policies`)
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

  // um-rel-12 -----------------------------------------------------------
  it('um-rel-12 · move Alice from Dept A to Dept B → exactly one department (B), reporting access flips next request', async () => {
    const root = await seedActor('rel12-root');
    const alice = await fx.user('rel12-alice');
    const deptAManager = await fx.user('rel12-deptA-mgr');
    const deptBManager = await fx.user('rel12-deptB-mgr');
    // Department entity/id owned by the Department edge contract — placeholder.
    const deptBId = uuidv7();

    // Placeholder route per um-rel-12 Test 2 (shape-4 department-targeted policy).
    const res = await postPolicy(alice.id, root.id, {
      type: 'AR',
      targetType: 'department',
      targetId: deptBId,
      targetRole: 'member',
    });
    // BLOCKED: exact status/route owned by the Department edge contract.
    expect([200, 201]).toContain(res.status);

    // Next request: Dept B's manager resolves Reporting-line access to Alice,
    // Dept A's does not. BLOCKED — department-derived access is fail-closed
    // today (AD-12) and the interim facade is always-allow.
    expect((await readAs(alice.id, deptBManager.id)).status).toBe(200);
    expect((await readAs(alice.id, deptAManager.id)).status).toBe(403);

    // A `department_change` career event is appended through the UM application
    // boundary (Epic 3 Story 3.1 wiring) — no `UserEvents` model exists yet.
    // BLOCKED-contract-undefined; asserted here as intent only via the journal
    // proxy below.

    // CC-07: journal row assertion — red until CC-07 schema lands. AD-19 §3.4
    // target: one immutable before/after row { before: Dept A, after: Dept B }.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-13 -----------------------------------------------------------
  it('um-rel-13 · change Dept B manager Bob→Nina → Nina resolves reporting over Dept B + nested Dept C members next request', async () => {
    const root = await seedActor('rel13-root');
    const bob = await fx.user('rel13-bob-oldmgr');
    const nina = await fx.user('rel13-nina-newmgr');
    const aliceInB = await fx.user('rel13-alice-inB');
    const memberInC = await fx.user('rel13-member-inC'); // nested Dept C
    const deptBId = uuidv7(); // Department edge contract owns the real entity

    const res = await postPolicy(nina.id, root.id, {
      type: 'AR',
      targetType: 'department',
      targetId: deptBId,
      targetRole: 'manager',
    });
    // BLOCKED: exact status/route owned by the Department edge contract.
    expect([200, 201]).toContain(res.status);

    // Next request: Nina resolves Reporting-line access to every member of
    // Dept B AND its nested departments; Bob loses it. BLOCKED — the recursive
    // department walk is the Department edge contract's; `department` policy
    // rows contribute nothing today (fail-closed, AD-12).
    expect((await readAs(aliceInB.id, nina.id)).status).toBe(200);
    expect((await readAs(memberInC.id, nina.id)).status).toBe(200);
    expect((await readAs(aliceInB.id, bob.id)).status).toBe(403);

    // CC-07: journal row assertion — red until CC-07 schema lands. AD-19 §3.4
    // target: one before/after row { before: Bob, after: Nina }.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });

  // um-rel-14 -----------------------------------------------------------
  it('um-rel-14 · Root making itself Dept B\'s manager is rejected, no access change, no journal (§3.3)', async () => {
    const root = await seedActor('rel14-root');
    const deptBId = uuidv7();

    // Self-assignment: the policy subject (`:id`) is the actor. The doc's
    // body shape `{departmentId, managerId: rootId}` is on a route the
    // Department edge contract owns; the shape-4 placeholder below carries the
    // same intent (grant Root the Dept B manager AR).
    const res = await postPolicy(root.id, root.id, {
      type: 'AR',
      targetType: 'department',
      targetId: deptBId,
      targetRole: 'manager',
    });
    // Rejected — NOT 404 (route missing) and NOT 500.
    expect([400, 403, 409, 422]).toContain(res.status);

    // No department-manager policy row was written for Root.
    const policies = await testApp.prisma.userPolicy.findMany({
      where: { userId: root.id },
    });
    // Root holds exactly the one FR grant the fixture created — no new AR row.
    expect(policies).toHaveLength(1);

    // CC-07: once the table lands this asserts ZERO before/after rows.
    expect(await relationshipJournalTable(testApp.prisma)).not.toBeNull();
  });
});
