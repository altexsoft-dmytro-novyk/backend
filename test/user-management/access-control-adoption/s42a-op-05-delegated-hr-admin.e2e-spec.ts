import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { SECTION_ACCESS_MATRIX } from '../../../src/access-control/domain/constants/section-access-matrix';
import { queryDepartureRows } from '../epic-5/fixtures';
import { BACKEND_ROOT, toDeliveredCsv } from '../epic-1/fixtures';
import { bearer, expectExactS1CardEnvelope, s1CardOf } from './fixtures';
import {
  CANONICAL_KEYS,
  cityOf,
  countOf,
  csvRow,
  deactivateUser,
  delegateHrAdminToNadia,
  deleteDepartmentManager,
  deleteDepartmentMembership,
  deletePeoplePartner,
  deleteRelationship,
  edgesBetween,
  findEmployee,
  getDeparture,
  getUser,
  importCsv,
  importMarker,
  patchUser,
  postDeparture,
  postDepartmentMembership,
  postEvent,
  postRelationship,
  provisionRootOperatorFixtures,
  putDepartmentManager,
  putPeoplePartner,
  requireProvisioning,
  ROUTED_SECTION_WRITE_SURFACE,
  SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE,
  server,
  teardownRootOperatorFixtures,
  testApp,
} from './s42a-op-root-operator-set.fixtures';

/**
 * PLAT-E4-S4.2a — the root-operator permission set · AD-1 Stage 2 (red E2E,
 * written before any implementation code).
 *
 * Scenarios covered in THIS file (one `it` per doc Test, the `s42a-op-xx` id
 * in every title):
 *   docs/test-cases/user-management/access-control-adoption/
 *     s42a-op-05-delegated-hr-admin-gets-no-data-access.md
 *     s42a-op-06-delegated-hr-admin-timeline-write-accepted-deviation.md
 *
 * `s42a-op-03`/`s42a-op-04` live in the sibling file
 * `s42a-op-root-operator-set.e2e-spec.ts` in this same folder, whose header
 * comment carries the full HYBRID-harness rationale, the isolation mechanism,
 * and the two SEPARABLE red states — all identical here, not repeated. This
 * file was split out of it (H5, test-review-plat-e2-e4-2026-09-13.md) to keep
 * both files under the 1000-line cap. Both files import their shared
 * provisioning/HTTP-helper code from `./s42a-op-root-operator-set.fixtures.ts`
 * (see that module's own header comment for why sharing module-level state
 * across the two spec files is safe under Jest's per-file module isolation),
 * but each still runs its own independent `beforeAll`/`afterAll` — own
 * subprocess, own run-scoped database rows, no shared Nest instance. Every
 * `it` in this file kept the exact title it had before the split, so the
 * traceability matrix's file+title mapping only needed the file half updated
 * for these two scenario ids.
 *
 * There is deliberately no `RunFixtures` FR grant anywhere in this file —
 * every permission Nadia holds here came out of one real, in-suite
 * administrator-shaped delegation onto the bootstrap's own canonical policy
 * (see the "…and an administrator has delegated…" describe below).
 * `npm run db:dev:grant-root` is NOT run (asserted in `s42a-op-03
 * precondition 2`, sibling file).
 *
 * The data-denial halves of `s42a-op-05` / `s42a-op-06` are GREEN before AND
 * after Stage 3 by design: a red there would mean the increment widened data
 * access, and the change stops for a human.
 *
 * ── FIXTURE RULES ────────────────────────────────────────────────────────────
 * No hardcoded placeholder id anywhere. Every uuid is read back from a row a
 * real in-suite request created: root from `users` by its normalized
 * `ROOT_WORK_EMAIL`, the employees from `POST /users/import`, the department
 * from the `Department` row that import produced, the canonical policy by its
 * natural key (`type='FR' AND targetRole='hr-admin'`) from the bootstrap's own
 * output. Sessions are `Bearer <token:<uuid>>` per the fixture convention.
 */

// The suite shells out to `db:deploy` / `db:seed` / `db:bootstrap:access-control`
// and then boots Nest; Jest's 5s default would abort provisioning before any
// test logic ran (`acm1r-fr-foundation.e2e-spec.ts` carries the same guard).
jest.setTimeout(180_000);

beforeAll(async () => {
  await provisionRootOperatorFixtures();
  // Unconditional — NOT nested inside a `describe`'s own `beforeAll` — so
  // Nadia's delegation exists for any test in this file selected via a
  // `--testNamePattern` / `-t` filter, not only when the full file (or the
  // "…and an administrator has delegated…" describe specifically) runs.
  // See `delegateHrAdminToNadia`'s own comment (H4,
  // test-review-plat-e2-e4-2026-09-13.md).
  await delegateHrAdminToNadia();
});

afterAll(async () => {
  await teardownRootOperatorFixtures();
});

// ───────────────────────────────────────────────────────────────────────────
// Shared precondition — this file's half. `s42a-op-03 precondition 1/2` and
// `s42a-op-04 precondition` live in the sibling file, against their own
// database; nothing here depends on them having run (H4,
// test-review-plat-e2-e4-2026-09-13.md).
// ───────────────────────────────────────────────────────────────────────────
describe('shared precondition · the production path alone provisioned this database', () => {
  it('s42a-op-05 precondition · no Relationship row between Nadia and T in either direction', async () => {
    const p = requireProvisioning();
    expect(await edgesBetween(p.nadia.id, p.t.id)).toEqual([]);
  });

  describe('… and an administrator has delegated the canonical hr-admin role to Nadia', () => {
    // The delegation itself runs unconditionally in this file's top-level
    // `beforeAll` (`delegateHrAdminToNadia`), not here — see that function's
    // own comment for why a nested `describe`'s `beforeAll` was the wrong
    // place for it (H4, test-review-plat-e2-e4-2026-09-13.md). This describe
    // now only asserts that the delegation happened.
    it('s42a-op-05 precondition · Nadia is attached to the bootstrap’s own canonical policy and UserPolicies holds exactly 2 rows', async () => {
      const p = requireProvisioning();
      const attachments = await testApp.prisma.$queryRawUnsafe<
        Array<{ userId: string; policyId: string }>
      >(
        `SELECT up."userId", up."policyId"
           FROM "UserPolicies" up
           JOIN "Policies" p ON p.id = up."policyId"
          WHERE p.type = 'FR' AND p."targetRole" = 'hr-admin'
          ORDER BY up."userId"`,
      );
      expect(attachments.map(({ userId }) => userId).sort()).toEqual(
        [p.root.id, p.nadia.id].sort(),
      );
      expect(await countOf('UserPolicies')).toBe(2);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-05 — a delegated HR Admin gets zero data access from the six-key role.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-05 · a delegated HR Admin gets zero data access from the six-key role', () => {
  it('s42a-op-05 Test 1 · the delegated holder lists users → 200', async () => {
    // `user-management:list` reaches its gate through the canonical chain —
    // the delegation is real, not a fixture grant.
    const p = requireProvisioning();

    const res = await request(server())
      .get('/users')
      .set('authorization', bearer(p.nadia.id));

    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { items?: unknown[] }).items)).toBe(true);
  });

  it('s42a-op-05 Test 2 · she reads T’s card but cannot edit it → 200, canEdit false', async () => {
    // §3.2's profile:identity row gives Colleague `R`; six functional keys do
    // not turn that cell into `RW`.
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });

    const res = await getUser(p.t.id, p.nadia.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  it('s42a-op-05 Test 3 · her write is refused and the row is untouched → 403', async () => {
    // The NORMATIVE invariant (access-control.md line 19), restated for the
    // grown role: holding `profile:identity:write` implicitly through
    // DEFAULT_PERMISSIONS does not help her, because the audience half
    // resolves `read` and returns before the feature half is consulted.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);
  });

  it('s42a-op-05 Test 4 · the feature half of the role does open — relationship write and departure record both succeed', async () => {
    // Paired with Test 3 this is the whole claim of the increment: the role
    // gained feature reach and no data reach. Expected red before Stage 3:
    // both 403.
    const p = requireProvisioning();

    const relationship = await postRelationship(p.s2.id, p.nadia.id, p.t.id);
    expect(relationship.status).toBe(201);
    expect(relationship.body).toMatchObject({
      userId: p.s2.id,
      type: 'direct',
      reportsToUserId: p.t.id,
    });

    const departure = await postDeparture(p.s2.id, p.nadia.id);
    expect(departure.status).toBe(201);
    const rows = await queryDepartureRows(testApp.prisma, p.s2.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.s2.id, createdBy: p.nadia.id });
  });

  it('s42a-op-05 Test 5 · no other section opens for her — every routed section-write surface is 403 and the remaining sections have no route at all', async () => {
    // Stage-1 flag, honoured literally: the set of section write routes that
    // exists at the baseline commit is smaller than §3.2's matrix. This test
    // asserts over the routes that exist and RECORDS which sections have none,
    // rather than inventing endpoints for them.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    // (a) every routed section-write surface, driven for real.
    expect(ROUTED_SECTION_WRITE_SURFACE.map(({ section }) => section)).toEqual([
      'profile:identity',
    ]);
    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    // (b) the recorded gap: the remaining §3.2 sections have no routed write
    // surface, and none of them carries a `write` cell a colleague could reach
    // even once one is routed. `profile:personal-contacts`,
    // `profile:emergency-contacts` and `profile:documents` are not in
    // SECTION_ACCESS_MATRIX at all yet.
    for (const section of SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE) {
      expect(
        ROUTED_SECTION_WRITE_SURFACE.map((route) => route.section),
      ).not.toContain(section);
      expect(SECTION_ACCESS_MATRIX[section]?.colleague ?? 'none').not.toBe(
        'write',
      );
    }

    // (c) none of the six canonical keys is a section key.
    for (const key of CANONICAL_KEYS) {
      expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(key);
    }
  });

  // E4-C04c (PM/AD-24, CONFLICT-UM-01): the hidden-target 404 oracle
  // evidenced against the delegated HR Admin persona specifically — her six
  // canonical feature keys never reach the section decision, so a hidden
  // target is `404` for her exactly as it is for an ordinary caller.
  it('s42a-op-05 Test 6 · the delegated holder PATCHes a missing target id → 404, not 403', async () => {
    const p = requireProvisioning();

    const res = await patchUser(uuidv7(), p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
  });

  it('s42a-op-05 Test 7 · the delegated holder PATCHes an inactive target → 404, not 403, row unchanged', async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.ghost.id);

    const res = await patchUser(p.ghost.id, p.nadia.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
    expect(await cityOf(p.ghost.id)).toBe(before);
  });

  // ── E4-C04b (test-design-epic-platform-4.md): "every other hr-admin
  // feature route that exists at run time." Test 4 above already proved
  // `org:relationships:write` and `employee:departure:record` open for Nadia
  // through ONE route each (`POST .../relationships`, `POST .../departures`).
  // The rest of this describe block enumerates the REMAINING routes carrying
  // those same two feature keys (`relationships.controller.ts`,
  // `departments.controller.ts`, `departures.controller.ts`), plus
  // `user-management:create` and `user-management:deactivate`, each of which
  // has none of its routes exercised by Nadia elsewhere. All of it is real
  // HTTP against the real bootstrap-delegated role — no `RunFixtures` grant.
  it('s42a-op-05 Test 8 · org:relationships:write — she sets S2’s people partner to T → 200, edge persisted', async () => {
    const p = requireProvisioning();

    const res = await putPeoplePartner(p.s2.id, p.nadia.id, p.t.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: p.s2.id,
      type: 'people_partner',
      reportsToUserId: p.t.id,
    });
  });

  it('s42a-op-05 Test 9 · org:relationships:write — she removes S2’s people partner → 200, edge gone', async () => {
    const p = requireProvisioning();

    const res = await deletePeoplePartner(p.s2.id, p.nadia.id);

    expect(res.status).toBe(200);
    const remaining = await testApp.prisma.relationship.findMany({
      where: { userId: p.s2.id, type: 'people_partner' },
    });
    expect(remaining).toHaveLength(0);
  });

  it('s42a-op-05 Test 10 · org:relationships:write — she revokes the S2→T manager edge by id → 200, edge gone', async () => {
    const p = requireProvisioning();
    // The `direct` edge Test 4 created (`POST /users/<S2>/relationships` with
    // `targetId: T`) — read back, never a hardcoded id.
    const edge = await testApp.prisma.relationship.findFirst({
      where: { userId: p.s2.id, type: 'direct', reportsToUserId: p.t.id },
    });
    expect(edge).not.toBeNull();

    const res = await deleteRelationship(p.s2.id, edge!.id, p.nadia.id);

    expect(res.status).toBe(200);
    expect(
      await testApp.prisma.relationship.findUnique({ where: { id: edge!.id } }),
    ).toBeNull();
  });

  it('s42a-op-05 Test 11 · org:relationships:write — she gives T a second, concurrent department membership → 201', async () => {
    const p = requireProvisioning();

    const res = await postDepartmentMembership(
      p.t.id,
      p.nadia.id,
      p.departmentId,
    );

    expect(res.status).toBe(201);
    const current = await testApp.prisma.departmentMembership.findMany({
      where: { userId: p.t.id, validTo: null },
    });
    expect(current.map((m) => m.departmentId)).toContain(p.departmentId);
  });

  it('s42a-op-05 Test 12 · org:relationships:write — she closes that membership → 200, membership closed', async () => {
    const p = requireProvisioning();

    const res = await deleteDepartmentMembership(
      p.t.id,
      p.departmentId,
      p.nadia.id,
    );

    expect(res.status).toBe(200);
    const current = await testApp.prisma.departmentMembership.findMany({
      where: { userId: p.t.id, departmentId: p.departmentId, validTo: null },
    });
    expect(current).toHaveLength(0);
  });

  it('s42a-op-05 Test 13 · org:relationships:write — she sets T as the QA department’s manager → 200', async () => {
    const p = requireProvisioning();
    // T is this describe block's OWN fixture (imported alongside Nadia/S2/
    // ghost in the shared `beforeAll` above) and carries no departure of any
    // kind — asserted here, not assumed, so this test owns its precondition
    // structurally and does not depend on any other describe block (in this
    // file or the sibling file) having run first. `SetDepartmentManagerAction`
    // refuses a manager target with a non-applied departure (409
    // `target_has_scheduled_departure`), keyed on the target id alone
    // (`set-department-manager.action.ts`); T has none, so 200 is expected.
    // T is not Nadia herself, so no self-assignment 400 either.
    expect(await queryDepartureRows(testApp.prisma, p.t.id)).toHaveLength(0);

    const res = await putDepartmentManager(
      p.qaDepartmentId,
      p.nadia.id,
      p.t.id,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      departmentId: p.qaDepartmentId,
      managerUserId: p.t.id,
    });
  });

  it('s42a-op-05 Test 14 · org:relationships:write — she removes the QA department’s manager → 200', async () => {
    const p = requireProvisioning();

    const res = await deleteDepartmentManager(p.qaDepartmentId, p.nadia.id);

    expect(res.status).toBe(200);
    const managerLinks = await testApp.prisma.userPolicy.findMany({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: p.qaDepartmentId,
          targetRole: 'unit-manager',
        },
      },
    });
    expect(managerLinks).toHaveLength(0);
  });

  it('s42a-op-05 Test 15 · user-management:create — she imports one more employee → 200, created', async () => {
    const p = requireProvisioning();

    const res = await importCsv(
      p.nadia.id,
      toDeliveredCsv([
        csvRow('nadia-import', {
          DepartmentId: `${importMarker}-2`,
          DepartmentName: `${importMarker}-QA`,
        }),
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, errors: [] });
    const created = await findEmployee('nadia-import');
    expect(created?.isActive).toBe(true);
  });

  it('s42a-op-05 Test 16 · user-management:deactivate — she deactivates the employee she just imported → 200, isActive false', async () => {
    const p = requireProvisioning();
    const target = await findEmployee('nadia-import');
    expect(target).not.toBeNull();

    const res = await deactivateUser(target!.id, p.nadia.id);

    expect(res.status).toBe(200);
    const row = await testApp.prisma.user.findUnique({
      where: { id: target!.id },
    });
    expect(row?.isActive).toBe(false);
  });

  it('s42a-op-05 Test 17 · employee:departure:record — she reads back S2’s departure by id → 200', async () => {
    const p = requireProvisioning();
    // The departure Test 4 recorded for S2 — read back by natural key rather
    // than assumed, then exercised through the dedicated find-one route.
    const rows = await queryDepartureRows(testApp.prisma, p.s2.id);
    expect(rows.length).toBeGreaterThan(0);
    const departureId = rows[0].id;

    const res = await getDeparture(p.s2.id, departureId, p.nadia.id);

    expect(res.status).toBe(200);
  });

  // The other two `employee:departure:record` routes —
  // `POST :id/departures/:departureId/retry` (Story 5.2, requires a
  // `retry_wait` departure produced by a fenced-apply failure) and
  // `POST :id/departure-reparenting` (requires an unresolved reparenting
  // blocker) — need domain preconditions this suite does not build elsewhere
  // and are not exercised here. Structurally they carry the IDENTICAL
  // `@RequireFeature(RECORD_A_DEPARTURE_FEATURE)` decorator and the same
  // `AccessControlGuard`/`isAllowed` mechanism just proven open for Nadia via
  // `record` (Test 4) and `findOne` (Test 17) — confirmed by source read
  // (`departures.controller.ts`), not re-asserted by a fourth HTTP call.
  it('s42a-op-05 Test 18 · structural — retry and reparenting carry the identical employee:departure:record feature key', () => {
    const controllerPath = path.join(
      BACKEND_ROOT,
      'src/user-management/application/controllers/departures.controller.ts',
    );
    const source = readFileSync(controllerPath, 'utf8');
    const requireFeatureCalls = source.match(
      /@RequireFeature\(RECORD_A_DEPARTURE_FEATURE\)/g,
    );
    // record, findOne, retry, reparent — all four routes, one constant.
    expect(requireFeatureCalls).toHaveLength(4);
    expect(source).toContain(
      "const RECORD_A_DEPARTURE_FEATURE = 'employee:departure:record'",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-06 — a delegated HR Admin CAN write any employee's career timeline.
//
// A KNOWN, ACCEPTED DEVIATION from a NORMATIVE invariant, by the dated
// 2026-09-06 Product Owner ruling (AF-2). `canEditTimeline` discards its target
// (`void targetUserId`, then `isAllowed(viewer, 'profile:timeline:write')`
// alone), so seeding that key into the canonical role gives every present and
// future holder org-wide timeline write with no relationship to the target.
//
// DO NOT "FIX" THESE EXPECTATIONS BY INVERTING THEM. The scenario doc carries
// that instruction explicitly. A future increment that narrows
// `canEditTimeline` supersedes this file with a dated pointer; it does not
// rewrite it.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-06 · a delegated HR Admin can write any employee’s career timeline — a known accepted deviation', () => {
  let createdEventId: string | null = null;

  it('s42a-op-06 Test 1 · the delegated holder writes a stranger’s career timeline → 201, persisted against T', async () => {
    // Expected red before Stage 3: 403, because `profile:timeline:write` has
    // no holder at all on a pure production bootstrap at the baseline commit.
    // The red → green flip here IS the deviation being introduced.
    const p = requireProvisioning();

    const res = await postEvent(p.t.id, p.nadia.id, {
      type: 'position_change',
      eventDate: '2026-03-01',
    });

    expect(res.status).toBe(201);
    createdEventId = (res.body as { id?: string }).id ?? null;
    expect(typeof createdEventId).toBe('string');

    // Asserted against the database, not inferred from the status.
    const persisted = await testApp.prisma.userEvent.findUnique({
      where: { id: createdEventId! },
    });
    expect(persisted).toMatchObject({
      userId: p.t.id,
      type: 'position_change',
      source: 'manual',
      createdBy: p.nadia.id,
      deletedAt: null,
    });
  });

  it('s42a-op-06 Test 2 · she deletes an event on the same stranger’s timeline → 204, soft-deleted and absent from a follow-up read', async () => {
    const p = requireProvisioning();
    expect(createdEventId).not.toBeNull();

    const res = await request(server())
      .delete(`/users/${p.t.id}/events/${createdEventId}`)
      .set('authorization', bearer(p.nadia.id));

    expect(res.status).toBe(204);
    const persisted = await testApp.prisma.userEvent.findUnique({
      where: { id: createdEventId! },
    });
    expect(persisted?.deletedAt).not.toBeNull();

    // She can read the timeline back through canReadTimeline's "edit implies
    // read" fallback, and the deleted event is gone from it.
    const read = await request(server())
      .get(`/users/${p.t.id}/events`)
      .set('authorization', bearer(p.nadia.id));
    expect(read.status).toBe(200);
    expect(
      (read.body as { data: Array<{ id: string }> }).data.map(({ id }) => id),
    ).not.toContain(createdEventId);
  });

  it('s42a-op-06 Test 3 · the same viewer is still refused T’s identity card → 403 and canEdit false', async () => {
    // One section is audience-gated and closed, one is permission-gated and
    // open, for the same viewer over the same target. Putting both answers in
    // one scenario is the point. Green before and after.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const patched = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(patched.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });
    const read = await getUser(p.t.id, p.nadia.id);
    expect(read.status).toBe(200);
    expectExactS1CardEnvelope(read.body, s1CardOf(row!), false);
  });

  it('s42a-op-06 Test 4 · the deviation is bounded to the timeline — every other routed profile-section write stays 403', async () => {
    // A second open section would mean a second data-write key entered the
    // canonical set, which ACM1-FB-01 forbids. As in s42a-op-05 Test 5, the
    // assertion runs over the routes that exist and records the sections that
    // have none.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.nadia.id, { city: 'Berlin' });
    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);

    for (const section of SECTIONS_WITH_NO_ROUTED_WRITE_SURFACE) {
      expect(
        ROUTED_SECTION_WRITE_SURFACE.map((route) => route.section),
      ).not.toContain(section);
    }

    // `profile:timeline` is the ONLY section the canonical set can write, and
    // it reaches no section matrix row at all — which is exactly why the
    // deviation is invisible to `hasSectionAccess`.
    expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(
      'profile:timeline',
    );
  });
});
