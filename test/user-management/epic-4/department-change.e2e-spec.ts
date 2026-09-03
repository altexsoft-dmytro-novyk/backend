import request from 'supertest';
import {
  ORG_RELATIONSHIPS_WRITE_PERMISSION,
  RunFixtures,
  bearer,
  bootstrapTestApp,
  cleanupAccessJournal,
  expectLeakFreeBody,
  queryAccessJournalRows,
  queryAccessJournalRowsByKind,
  type TestApp,
} from './fixtures';

/**
 * Epic 4 — Organisational Relationships · Story 4.3 (Change Employee Department
 * or Department Manager) · AD-1 Stage 2, committed red — SPLIT-GATE.
 *
 * Scenarios: docs/test-cases/user-management/relationships/
 *   um-rel-12-change-department.md            (LIVE: the move; DEFERRED: Test 3)
 *   um-rel-13-change-department-manager.md    (LIVE: the manager edge + journal;
 *                                              DEFERRED: the whole recursive access half)
 *   um-rel-14-department-self-assignment-rejected.md  (LIVE — app pre-check)
 *   um-rel-17-department-membership-add-remove.md     (LIVE: add / remove / ≥1 floor / 404)
 *
 * RECONCILED 2026-09-03 to the Story 4.3 split-gate (spec-4-3,
 * epic-4-context.md "Department edge contract"). The old "BLOCKED — CC-07 +
 * Department edge contract; scenario prose only" framing is removed:
 *   - CC-07 / PM/AD-29 (`AccessJournal`) — DONE via Story 4.1 (table,
 *     `AccessJournalKind` enum incl. `department_membership` + `department_manager`,
 *     same-transaction writer, `GET /users/:id/access-journal`; migration
 *     `20260903011657_story_4_1_access_journal`).
 *   - `department_change` `UserEvents` mechanism — DONE via Epic 3 Story 3.1
 *     (the `department_change` `type` slot + the synchronous same-tx append).
 *   - Department edge SCHEMA — PRESENT: `Department.parentId` (self-relation
 *     `DeptTree`, `onDelete: Restrict`), `DepartmentMembership` (temporal, partial
 *     `UNIQUE (userId, departmentId) WHERE validTo IS NULL`), `Policies.targetType`
 *     polymorphic `String?` (stores `'department'` rows) — Story 1.1, migration
 *     `20260902001941_story_1_1_import_population`.
 *
 * So the department **membership** write, the department-**manager** write (an
 * AR `Policies` row `targetType:'department'` + a `UserPolicies` link), the
 * same-tx `department_change` `UserEvents` row, and the same-tx `AccessJournal`
 * row are all **first-class LIVE stage-2 `it()` assertions**. They are RED today
 * for ONE reason — **red-because-route-missing**: `RelationshipsController`
 * (`relationships.controller.ts`) has no `:id/departments` handler and there is
 * no `/departments` controller at all, so `POST /users/:id/departments`,
 * `DELETE /users/:id/departments/:departmentId`, and
 * `PUT /departments/:deptId/manager` every one 404s, leaving the seeded state
 * untouched and writing no event and no journal row.
 *
 * The **one hard blocker that remains** is the `AccessControlFacade` /
 * `AudienceResolverService` walk for `targetType:'department'` `Policies` rows +
 * `Department.parentId` recursion — today `department`-targeted policy rows
 * contribute NOTHING to tier resolution (fail-closed, AD-12). That is an
 * Access-Control-kernel increment (`spec-access-control-kernel-mvp`, approver
 * Anna Pikula), NOT User-Management work. Every department-derived
 * **access-resolution** consequence is therefore a DEFERRED `it.todo` here, each
 * titled with the single documented unblock trigger.
 *
 * Approved scenario-stage decisions encoded here (spec-4-3 §"Scenario-stage
 * decisions"):
 *   1. Membership `POST /users/:id/departments { departmentId, fromDepartmentId? }`
 *      — `fromDepartmentId` present = atomic named-source move (end that source
 *      membership `validTo=today` + add target, one tx); absent = plain add.
 *      `DELETE /users/:id/departments/:departmentId` = remove that membership.
 *      `≥1` floor: `DELETE` of the last current membership → `409`; `DELETE` of a
 *      non-membership → `404`.
 *   2. Department-manager `PUT /departments/:deptId/manager { managerUserId,
 *      expectedCurrentManagerId? }` + `DELETE /departments/:deptId/manager`.
 *      Storage: `Policies { operator:'==', targetType:'department',
 *      targetId:<deptId>, targetRole:'unit-manager', type:'AR',
 *      managedBy:'admin' }` + `UserPolicies { userId:<managerId>, policyId }`.
 *      Self-assignment (`managerUserId` === the acting session user, when they do
 *      not already manage it) → `400`, no `Policies`/`UserPolicies` row, no
 *      journal, before the transaction opens.
 *   3. `department_change` `UserEvents` row appended in the SAME transaction as
 *      every membership change: add / move-target → `details: { department:
 *      <departmentId> }`; remove → `details: { department: <departmentId>,
 *      removed: true }`. A move emits ONE event (add form).
 *   4. `AccessJournal` row same-tx: `kind:'department_membership'` for a
 *      membership change (`before`/`after` = dept-id snapshot — add `before:null`,
 *      remove `after:null`, move `before:` old dept `after:` new);
 *      `kind:'department_manager'` for a manager change (`before`/`after` =
 *      manager user-id snapshot). The `subjectUserId`-is-a-User-FK issue for a
 *      `department_manager` subject is a Stage-3 concern (`spec-4-3` flag —
 *      Stage 3 adds a nullable `subjectDepartmentId`); Stage 2 asserts the row by
 *      `kind` + `before`/`after` only (`queryAccessJournalRowsByKind`).
 *   5. Gate `@RequireFeature('org:relationships:write')` on every write
 *      (no-target `isAllowed` through the facade, never a role-name check).
 *
 * AD-3: real `AppModule`, real Prisma / migrated PostgreSQL, NO
 * `overrideProvider`. DEC-UM-010: one worker, run-namespaced data, wrapped
 * scoped teardown. `fx.grantFunctionalRole(id, [ORG_RELATIONSHIPS_WRITE_PERMISSION])`
 * for the write actor — one FR-granted actor per test (the known
 * `RunFixtures` targetRole-collision caveat). Departments / memberships / the
 * department-manager AR `Policies` rows are genuine preconditions with no
 * HTTP-observable seam in this suite, so they are seeded directly via Prisma
 * (nest-e2e.md precondition rule) — the models exist.
 */
describe('Epic 4 · Story 4.3 — Change Employee Department / Department Manager (e2e, committed red — split-gate)', () => {
  let testApp: TestApp;
  let fx: RunFixtures;
  /** Every `Department` row this test seeded — torn down before `fx.cleanup()`. */
  let deptIds: string[];

  const prisma = () => testApp.prisma;
  const server = () => testApp.app.getHttpServer();

  // --- routes under test (all 404 today) -----------------------------------
  const postDepartments = (
    userId: string,
    actorId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`/users/${userId}/departments`)
      .set('authorization', bearer(actorId))
      .send(body);

  const deleteDepartment = (
    userId: string,
    departmentId: string,
    actorId: string,
  ) =>
    request(server())
      .delete(`/users/${userId}/departments/${departmentId}`)
      .set('authorization', bearer(actorId));

  const putDeptManager = (
    deptId: string,
    actorId: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/departments/${deptId}/manager`)
      .set('authorization', bearer(actorId))
      .send(body);

  // --- seeding (direct Prisma — genuine preconditions, no HTTP seam) -------
  const seedActor = async (persona: string) => {
    const root = await fx.user(persona, { position: 'HR Admin' });
    await fx.grantFunctionalRole(root.id, [ORG_RELATIONSHIPS_WRITE_PERMISSION]);
    return root;
  };

  const seedDepartment = async (label: string, parentId?: string) => {
    const dept = await prisma().department.create({
      data: { name: `${fx.runId}-${label}`, externalId: null, parentId },
    });
    deptIds.push(dept.id);
    return dept;
  };

  const seedMembership = async (
    userId: string,
    departmentId: string,
    opts: { validFrom?: Date; validTo?: Date | null } = {},
  ) =>
    prisma().departmentMembership.create({
      data: {
        userId,
        departmentId,
        validFrom: opts.validFrom ?? new Date(),
        validTo: opts.validTo ?? null,
      },
    });

  /** The department-manager fact: an AR `Policies` row + a `UserPolicies` link. */
  const seedDeptManager = async (departmentId: string, managerId: string) => {
    const policy = await prisma().policy.create({
      data: {
        operator: '==',
        targetType: 'department',
        targetId: departmentId,
        targetRole: 'unit-manager',
        type: 'AR',
        managedBy: 'admin',
      },
    });
    await prisma().userPolicy.create({
      data: { userId: managerId, policyId: policy.id },
    });
    return policy;
  };

  // --- readback helpers ---------------------------------------------------
  const currentMemberships = (userId: string) =>
    prisma().departmentMembership.findMany({
      where: { userId, validTo: null },
      orderBy: { validFrom: 'asc' },
    });

  const deptChangeEvents = (userId: string) =>
    prisma().userEvent.findMany({
      where: { userId, type: 'department_change', deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

  const unitManagerPolicies = (departmentId: string) =>
    prisma().policy.findMany({
      where: {
        type: 'AR',
        targetType: 'department',
        targetId: departmentId,
        targetRole: 'unit-manager',
      },
    });

  const unitManagerLinks = (departmentId: string) =>
    prisma().userPolicy.findMany({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: departmentId,
          targetRole: 'unit-manager',
        },
      },
    });

  beforeAll(async () => {
    testApp = await bootstrapTestApp();
  });

  beforeEach(() => {
    fx = new RunFixtures(testApp.prisma);
    deptIds = [];
  });

  afterEach(async () => {
    const userIds = [...fx.userIds];
    const steps: Array<() => Promise<unknown>> = [
      () => cleanupAccessJournal(testApp.prisma, userIds),
      () =>
        testApp.prisma.userEvent.deleteMany({
          where: { userId: { in: userIds } },
        }),
      () =>
        testApp.prisma.departmentMembership.deleteMany({
          where: { userId: { in: userIds } },
        }),
      () =>
        testApp.prisma.userPolicy.deleteMany({
          where: { policy: { targetId: { in: deptIds } } },
        }),
      () =>
        testApp.prisma.policy.deleteMany({
          where: { targetId: { in: deptIds } },
        }),
      () =>
        testApp.prisma.department.deleteMany({
          where: { id: { in: deptIds } },
        }),
      () => fx.cleanup(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        console.warn('[epic-4 · story-4.3] teardown step failed', error);
      }
    }
  });

  afterAll(async () => {
    await testApp.app.close();
    await testApp.moduleFixture.close();
  });

  // ======================================================================
  // um-rel-12 — move an employee's department (named-source atomic move)
  // ======================================================================
  it('um-rel-12 · move Alice A→B → one current membership (B), A closed; one same-tx `department_change` event (details.department=B); one same-tx `department_membership` journal row (before:A, after:B)', async () => {
    const root = await seedActor('rel12-root');
    const alice = await fx.user('rel12-alice');
    const deptAManager = await fx.user('rel12-deptA-mgr');
    const deptBManager = await fx.user('rel12-deptB-mgr');
    const deptA = await seedDepartment('deptA');
    const deptB = await seedDepartment('deptB');
    await seedMembership(alice.id, deptA.id); // sole current membership
    await seedDeptManager(deptA.id, deptAManager.id);
    await seedDeptManager(deptB.id, deptBManager.id);

    const res = await postDepartments(alice.id, root.id, {
      departmentId: deptB.id,
      fromDepartmentId: deptA.id,
    });
    // red-because-route-missing: no `:id/departments` handler → 404.
    expect([200, 201]).toContain(res.status);

    // Membership: A closed (`validTo` set), exactly one current row — B.
    const current = await currentMemberships(alice.id);
    expect(current).toHaveLength(1);
    expect(current[0]?.departmentId).toBe(deptB.id);
    const closedA = await prisma().departmentMembership.findFirst({
      where: {
        userId: alice.id,
        departmentId: deptA.id,
        NOT: { validTo: null },
      },
    });
    expect(closedA).not.toBeNull();

    // Exactly ONE `department_change` event, add form, same transaction.
    const events = await deptChangeEvents(alice.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('system');
    expect(events[0]?.createdBy).toBe(root.id);
    expect(events[0]?.details).toMatchObject({ department: deptB.id });
    expect(events[0]?.details).not.toMatchObject({ removed: true });

    // Exactly ONE `department_membership` journal row, same transaction.
    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'department_membership',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'department_membership',
      actorUserId: root.id,
      subjectUserId: alice.id,
    });
    expect(journal[0]?.before).toMatchObject({ departmentId: deptA.id });
    expect(journal[0]?.after).toMatchObject({ departmentId: deptB.id });
    expect(journal[0]?.occurredAt).toBeTruthy();
    expect(journal[0]?.idempotencyKey).toBeTruthy();
  });

  // um-rel-12 Test 3 — DEFERRED (department-derived access resolution) -------
  it.todo(
    "um-rel-12 T3 · after the move, Department B's manager resolves Reporting-line access to Alice on the next request and Department A's manager loses it — unblocks when the AC resolveAudiences walk for targetType:'department' + Department.parentId recursion reaches stage-3-production (spec-access-control-kernel-mvp)",
  );

  // ======================================================================
  // um-rel-13 — change a department's manager (edge write + journal only)
  // ======================================================================
  it("um-rel-13 · change Dept B manager Bob→Nina → exactly one `unit-manager` AR `Policies` row for Dept B linked to Nina, Bob's link gone; one same-tx `department_manager` journal row (before:Bob, after:Nina)", async () => {
    const root = await seedActor('rel13-root');
    const bob = await fx.user('rel13-bob-oldmgr');
    const nina = await fx.user('rel13-nina-newmgr');
    const aliceInB = await fx.user('rel13-alice-inB');
    const deptB = await seedDepartment('deptB');
    const deptC = await seedDepartment('deptC', deptB.id); // nested sub-department
    await seedMembership(aliceInB.id, deptB.id);
    await seedDeptManager(deptB.id, bob.id); // current manager

    const res = await putDeptManager(deptB.id, root.id, {
      managerUserId: nina.id,
      expectedCurrentManagerId: bob.id,
    });
    // red-because-route-missing: no `/departments` controller → 404.
    expect(res.status).toBe(200);

    // Exactly one `unit-manager` AR row for Dept B, linked to Nina only.
    const arRows = await unitManagerPolicies(deptB.id);
    expect(arRows).toHaveLength(1);
    const links = await unitManagerLinks(deptB.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.userId).toBe(nina.id);

    // Bob's prior link is gone.
    const bobLinks = await prisma().userPolicy.findMany({
      where: { userId: bob.id, policy: { targetId: deptB.id } },
    });
    expect(bobLinks).toHaveLength(0);

    // Exactly one `department_manager` journal row — located by `kind` +
    // `before`/`after` only (the subject column shape is a Stage-3 concern).
    const journal = await queryAccessJournalRowsByKind(
      testApp.prisma,
      'department_manager',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'department_manager',
      actorUserId: root.id,
    });
    expect(journal[0]?.before).toMatchObject({ managerUserId: bob.id });
    expect(journal[0]?.after).toMatchObject({ managerUserId: nina.id });
    expect(journal[0]?.occurredAt).toBeTruthy();
    expect(journal[0]?.idempotencyKey).toBeTruthy();

    // `deptC` exists only to anchor the DEFERRED recursive-walk `it.todo`.
    expect(deptC.parentId).toBe(deptB.id);
  });

  // um-rel-13 Test 3 — DEFERRED (the entire recursive-access half) ----------
  it.todo(
    "um-rel-13 T3 · the new department manager (Nina) resolves Reporting-line access to every member of Department B AND its nested sub-departments' members on the next request, the old manager (Bob) does not (the recursive walk) — unblocks when the AC resolveAudiences walk for targetType:'department' + Department.parentId recursion reaches stage-3-production (spec-access-control-kernel-mvp)",
  );

  // ======================================================================
  // um-rel-14 — making yourself a department's manager is rejected
  // ======================================================================
  it("um-rel-14 · Root making itself Dept B's manager → 400 before the tx opens; no `Policies` row, no `UserPolicies` link for Root, no `department_manager` journal row", async () => {
    const root = await seedActor('rel14-root');
    const bob = await fx.user('rel14-bob-mgr');
    const deptB = await seedDepartment('deptB');
    await seedDeptManager(deptB.id, bob.id); // Root is NOT the current manager

    const res = await putDeptManager(deptB.id, root.id, {
      managerUserId: root.id,
    });
    // Rejected as invalid input — NOT 404 (route missing) and NOT 500.
    expect(res.status).toBe(400);

    // No `unit-manager` AR link was created for Root; Bob's row is untouched.
    const rootLinks = await prisma().userPolicy.findMany({
      where: { userId: root.id, policy: { targetId: deptB.id } },
    });
    expect(rootLinks).toHaveLength(0);
    const arRows = await unitManagerPolicies(deptB.id);
    expect(arRows).toHaveLength(1);
    const links = await unitManagerLinks(deptB.id);
    expect(links).toHaveLength(1);
    expect(links[0]?.userId).toBe(bob.id);

    // No journal row.
    const journal = await queryAccessJournalRowsByKind(
      testApp.prisma,
      'department_manager',
    );
    expect(journal).toHaveLength(0);
  });

  // ======================================================================
  // um-rel-17 — membership add / remove / ≥1 floor / non-membership 404
  // ======================================================================
  it('um-rel-17 T1 · add a 2nd membership (`POST` without `fromDepartmentId`) → Alice now current in A AND B; one `department_change` event (details.department=B); one `department_membership` journal row (before:null, after:B)', async () => {
    const root = await seedActor('rel17t1-root');
    const alice = await fx.user('rel17t1-alice');
    const deptA = await seedDepartment('deptA');
    const deptB = await seedDepartment('deptB');
    await seedMembership(alice.id, deptA.id);

    const res = await postDepartments(alice.id, root.id, {
      departmentId: deptB.id,
    });
    expect([200, 201]).toContain(res.status);

    const current = await currentMemberships(alice.id);
    expect(current.map((m) => m.departmentId).sort()).toEqual(
      [deptA.id, deptB.id].sort(),
    );

    const events = await deptChangeEvents(alice.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ department: deptB.id });
    expect(events[0]?.details).not.toMatchObject({ removed: true });

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'department_membership',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'department_membership',
      actorUserId: root.id,
      subjectUserId: alice.id,
      before: null,
    });
    expect(journal[0]?.after).toMatchObject({ departmentId: deptB.id });
    expect(journal[0]?.idempotencyKey).toBeTruthy();
  });

  it('um-rel-17 T2 · remove one of two (`DELETE /users/:id/departments/B`) → Alice still current in A, B closed; one `department_change` event (details {department:B, removed:true}); one `department_membership` journal row (before:B, after:null)', async () => {
    const root = await seedActor('rel17t2-root');
    const alice = await fx.user('rel17t2-alice');
    const deptA = await seedDepartment('deptA');
    const deptB = await seedDepartment('deptB');
    await seedMembership(alice.id, deptA.id);
    await seedMembership(alice.id, deptB.id); // Alice starts in A and B

    const res = await deleteDepartment(alice.id, deptB.id, root.id);
    expect(res.status).toBe(200);

    const current = await currentMemberships(alice.id);
    expect(current).toHaveLength(1);
    expect(current[0]?.departmentId).toBe(deptA.id);
    const closedB = await prisma().departmentMembership.findFirst({
      where: {
        userId: alice.id,
        departmentId: deptB.id,
        NOT: { validTo: null },
      },
    });
    expect(closedB).not.toBeNull();

    const events = await deptChangeEvents(alice.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({
      department: deptB.id,
      removed: true,
    });

    const journal = await queryAccessJournalRows(
      testApp.prisma,
      alice.id,
      'department_membership',
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      kind: 'department_membership',
      actorUserId: root.id,
      subjectUserId: alice.id,
      after: null,
    });
    expect(journal[0]?.before).toMatchObject({ departmentId: deptB.id });
  });

  it('um-rel-17 T3 · remove the LAST current membership (`DELETE /users/:id/departments/A`) → 409, leak-free; A still current; no `department_change` event, no journal row', async () => {
    const root = await seedActor('rel17t3-root');
    const alice = await fx.user('rel17t3-alice');
    const deptA = await seedDepartment('deptA');
    await seedMembership(alice.id, deptA.id); // sole current membership

    const res = await deleteDepartment(alice.id, deptA.id, root.id);
    expect(res.status).toBe(409);
    expectLeakFreeBody(res.body, alice);

    const current = await currentMemberships(alice.id);
    expect(current).toHaveLength(1);
    expect(current[0]?.departmentId).toBe(deptA.id);

    expect(await deptChangeEvents(alice.id)).toHaveLength(0);
    expect(
      await queryAccessJournalRows(
        testApp.prisma,
        alice.id,
        'department_membership',
      ),
    ).toHaveLength(0);
  });

  it('um-rel-17 T4 · `DELETE` of a department Alice is not a current member of → 404, leak-free; no state change, no event, no journal row', async () => {
    const root = await seedActor('rel17t4-root');
    const alice = await fx.user('rel17t4-alice');
    const deptA = await seedDepartment('deptA');
    const deptC = await seedDepartment('deptC'); // Alice is NOT a member
    await seedMembership(alice.id, deptA.id);

    const res = await deleteDepartment(alice.id, deptC.id, root.id);
    expect(res.status).toBe(404);
    // red-because-route-missing today: Nest's route-miss 404 body echoes the
    // request path (`Cannot DELETE /users/<aliceId>/departments/<deptCId>`),
    // which leaks `alice.id`. Goes green when the handler answers a leak-free
    // `NotFoundException` for a non-membership.
    expectLeakFreeBody(res.body, alice);

    const current = await currentMemberships(alice.id);
    expect(current).toHaveLength(1);
    expect(current[0]?.departmentId).toBe(deptA.id);
    expect(await deptChangeEvents(alice.id)).toHaveLength(0);
    expect(
      await queryAccessJournalRows(
        testApp.prisma,
        alice.id,
        'department_membership',
      ),
    ).toHaveLength(0);
  });

  // um-rel-17 — DEFERRED (department-derived access follows the membership set)
  it.todo(
    "um-rel-17 · adding/removing a DepartmentMembership changes which department managers resolve Reporting-line access to the employee on the next request — unblocks when the AC resolveAudiences walk for targetType:'department' + Department.parentId recursion reaches stage-3-production (spec-access-control-kernel-mvp)",
  );
});
