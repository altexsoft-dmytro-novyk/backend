import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { uuidv7 } from 'uuidv7';
import { SECTION_ACCESS_MATRIX } from '../../../src/access-control/domain/constants/section-access-matrix';
import { queryDepartureRows } from '../epic-5/fixtures';
import { BACKEND_ROOT, normalizeEmail } from '../epic-1/fixtures';
import { expectExactS1CardEnvelope, s1CardOf } from './fixtures';
import {
  ADDED_FEATURE_KEYS,
  CANONICAL_KEYS,
  cityOf,
  countOf,
  edgesBetween,
  getUser,
  patchUser,
  permissionKeys,
  postDeparture,
  postRelationship,
  provisionRootOperatorFixtures,
  putDepartmentManager,
  requireProvisioning,
  ROOT_WORK_EMAIL,
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
 *     s42a-op-03-root-operator-capability-after-production-bootstrap.md
 *     s42a-op-04-root-data-reach-unchanged-by-the-operator-set.md
 *
 * `s42a-op-05` (delegated HR Admin gets no data access) and `s42a-op-06`
 * (delegated HR Admin timeline-write accepted deviation) live in the sibling
 * file `s42a-op-05-delegated-hr-admin.e2e-spec.ts` in this same folder — split
 * out (H5, test-review-plat-e2-e4-2026-09-13.md) to keep both files under the
 * 1000-line cap. Both files import their shared provisioning/HTTP-helper code
 * from `./s42a-op-root-operator-set.fixtures.ts` (see that module's own header
 * comment for why sharing module-level state across the two spec files is
 * safe under Jest's per-file module isolation), but each still runs its own
 * independent `beforeAll`/`afterAll` — own subprocess, own run-scoped
 * database rows, no shared Nest instance. Every `it` in this file kept the
 * exact title it had before the split.
 *
 * ── HARNESS SHAPE ────────────────────────────────────────────────────────────
 * spec-4-2a § "Open item carried into the Stage-2 gate — the harness shape",
 * RESOLVED 2026-09-06 (John, PM): build the HYBRID harness. This suite
 *   (1) provisions the database through the REAL production path as a
 *       subprocess — `db:deploy` → `db:seed` → `db:bootstrap:access-control`,
 *       reusing `epic-1/fixtures.ts`'s `runScript` (the same `execFile` on
 *       `npm run <script>` that `acm1r-fr-foundation.e2e-spec.ts` uses),
 *   (2) boots Nest via `Test.createTestingModule` against that same database
 *       (`bootstrapTestApp`, unchanged — real `AppModule`, real Prisma, no
 *       `overrideProvider`), and
 *   (3) drives the scenarios over HTTP.
 *
 * Granting the operator keys with `fx.grantFunctionalRole` and skipping the
 * script is EXPLICITLY REJECTED by that ruling: it would test the gate while
 * leaving the seed unproven, and the seed is the entire subject of this
 * increment. There is deliberately no `RunFixtures` FR grant anywhere in this
 * file — every permission a viewer holds here came out of the real bootstrap.
 * `npm run db:dev:grant-root` is NOT run, and the suite asserts it was not.
 *
 * ── ISOLATION (binding constraint of the same ruling) ────────────────────────
 * The bootstrap mutates singleton global state (root identity, the one
 * `hr-admin` FR policy) that other suites read, and `test:e2e` runs
 * `--runInBand` against one shared database. The mechanism in
 * `./s42a-op-root-operator-set.fixtures.ts` is
 * `acm1r-fr-foundation.e2e-spec.ts`'s, reused and NOT reinvented:
 * `resetBootstrapState()` deletes the five bootstrap-owned tables in the same
 * RESTRICT-safe order, and this suite's `users` rows carry a run-scoped,
 * suite-prefixed namespace that teardown sweeps.
 *
 * The one scoping difference, stated rather than hidden: `acm1r` resets in
 * `beforeEach` because each of its tests runs the bootstrap itself. Here the
 * bootstrap-provisioned state IS the fixture every test in the file reads, so
 * the same reset runs once in `beforeAll` (before provisioning) and once in
 * `afterAll`. Same tables, same order, same run-scoped user sweep.
 *
 * ── EXPECTED RED at `services/backend` HEAD ef03c88, in two SEPARABLE states ─
 *   (1) PRECONDITION-REPAIR RED — `package.json` has no
 *       `db:bootstrap:access-control` key (AF-1), so the bootstrap cannot be
 *       invoked by name at all. Every failure raised through
 *       `requireProvisioning()` is labelled `PRECONDITION-REPAIR RED` in its
 *       own message and proves NOTHING about the canonical set.
 *   (2) DISCRIMINATING RED — the canonical set is three keys where these
 *       scenarios need six. Its oracle is the shared precondition test
 *       (`Permissions` `3 !== 6`) and the `403 → 200/201` inversions in
 *       `s42a-op-03` Tests 2-4 (this file) and `s42a-op-05` Test 4 /
 *       `s42a-op-06` Tests 1-2 (sibling file).
 *
 * `s42a-op-04` is GREEN before AND after Stage 3 by design: a red there would
 * mean the increment widened data access, and the change stops for a human.
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
});

afterAll(async () => {
  await teardownRootOperatorFixtures();
});

// ───────────────────────────────────────────────────────────────────────────
// Shared preconditions.
//
// Declared FIRST on purpose. The counting assertions the scenario docs carry
// (`Permissions` = 6, `UserPolicies` = 1) are literal facts about the freshly
// provisioned database, and `s42a-op-03` Test 4 legitimately adds an AR
// `unit-manager` attachment through the real `PUT /departments/:deptId/manager`
// route. Asserting them here — before any scenario write — keeps every count
// exactly as its doc states it, without weakening any of them.
//
// `s42a-op-05`'s own precondition (no Relationship row between Nadia and T)
// and the "administrator delegates hr-admin to Nadia" setup live in the
// sibling file `s42a-op-05-delegated-hr-admin.e2e-spec.ts`, against that
// file's own independently provisioned database (H4/H5,
// test-review-plat-e2-e4-2026-09-13.md) — root and Nadia are never both
// attached to the same `Policies` row this file provisions, which is why
// `UserPolicies` stays at exactly 1 below rather than 2.
// ───────────────────────────────────────────────────────────────────────────
describe('shared precondition · the production path alone provisioned this database', () => {
  it('s42a-op-03 precondition 1 · db:deploy → db:seed → db:bootstrap:access-control all exit 0 and root is readable back', () => {
    const p = requireProvisioning();
    expect(p.deploy.exitCode).toBe(0);
    expect(p.seed.exitCode).toBe(0);
    expect(p.bootstrap.exitCode).toBe(0);
    expect(normalizeEmail(p.root.workEmail)).toBe(ROOT_WORK_EMAIL);
    expect(p.root.isActive).toBe(true);
  });

  it('s42a-op-03 precondition 2 · db:dev:grant-root was NOT run — Permissions is the canonical six, not the stopgap superset, and UserPolicies holds exactly one row', async () => {
    // THE DISCRIMINATING ORACLE. At the baseline commit this fails `3 !== 6`
    // (once the AF-1 alias exists); it is the one assertion in this file that
    // measures the canonical set directly rather than through a route.
    requireProvisioning();
    expect(await permissionKeys()).toEqual([...CANONICAL_KEYS].sort());
    expect(await countOf('Permissions')).toBe(6);
    expect(await countOf('PolicyPermissions')).toBe(6);
    expect(await countOf('UserPolicies')).toBe(1);
    expect(await countOf('Policies')).toBe(1);
  });

  it('s42a-op-04 precondition · no Relationship row between root and T in either direction', async () => {
    const p = requireProvisioning();
    expect(await edgesBetween(p.root.id, p.t.id)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-03 — root provisioned only by the production bootstrap can wire
// relationships and record departures.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-03 · root provisioned only by the production bootstrap can wire relationships and record departures', () => {
  it('s42a-op-03 Test 1 · root imports the population — `user-management:create` reaches its gate → 200, two employees created', () => {
    // Break caught: a 403 here means the bootstrap did not attach root to the
    // canonical role at all, and the rest of this scenario is not meaningful.
    // Also the source of every employee uuid below — no id in this file stands
    // for state that nothing created.
    const p = requireProvisioning();
    expect(p.importOperators.status).toBe(200);
    expect(p.importOperators.body).toMatchObject({
      created: 2,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(p.s.isActive).toBe(true);
    expect(p.m.isActive).toBe(true);
  });

  it('s42a-op-03 Test 2 · root wires a manager edge (`org:relationships:write`) → 201, the direct edge persisted', async () => {
    // Expected red before Stage 3: 403 — `org:relationships:write` is not in
    // the canonical set at the baseline commit and no other seeded grant
    // supplies it.
    const p = requireProvisioning();

    const res = await postRelationship(p.s.id, p.root.id, p.m.id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId: p.s.id,
      type: 'direct',
      reportsToUserId: p.m.id,
    });
    // Asserted against the row, not inferred from the status.
    const persisted = await testApp.prisma.relationship.findMany({
      where: { userId: p.s.id, type: 'direct' },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].reportsToUserId).toBe(p.m.id);
  });

  it('s42a-op-03 Test 3 · root records a departure (`employee:departure:record`) → 201, the departure persisted for S', async () => {
    // Expected red before Stage 3: 403 — `employee:departure:record` is not in
    // the canonical set at the baseline commit.
    const p = requireProvisioning();

    const res = await postDeparture(p.s.id, p.root.id);

    expect(res.status).toBe(201);
    const rows = await queryDepartureRows(testApp.prisma, p.s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.s.id, createdBy: p.root.id });
  });

  it('s42a-op-03 Test 4 · the department-manager route carries the same key → 200, M persisted as the department’s manager', async () => {
    // Included because `org:relationships:write` gates TWO controllers: a
    // canonical set that reached only relationships.controller.ts would still
    // leave a live gate closed. `<deptId>` is the row root's own import
    // produced, never written literally. Expected red before Stage 3: 403.
    const p = requireProvisioning();

    const res = await putDepartmentManager(p.departmentId, p.root.id, p.m.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      departmentId: p.departmentId,
      managerUserId: p.m.id,
    });
    const managerLinks = await testApp.prisma.userPolicy.findMany({
      where: {
        policy: {
          type: 'AR',
          targetType: 'department',
          targetId: p.departmentId,
          targetRole: 'unit-manager',
        },
      },
    });
    expect(managerLinks.map(({ userId }) => userId)).toEqual([p.m.id]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-04 — the grown operator set gives root no data reach it did not
// already have. GREEN before and after Stage 3; a red here at Stage 3 means the
// increment widened data access and the change stops for a human.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-04 · the grown operator set gives root no data reach it did not already have', () => {
  it('s42a-op-04 Test 1 · root cannot edit an unrelated identity card → 403, T’s row unchanged', async () => {
    // `PATCH /users/:id` is gated `@RequireSectionAccess('profile:identity',
    // 'write')`, whose audience half resolves FIRST and returns before any
    // isAllowed call. Root's edit reach comes from tree position, and
    // prisma/seed.ts writes no Relationship row anywhere.
    const p = requireProvisioning();
    const before = await cityOf(p.t.id);

    const res = await patchUser(p.t.id, p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(403);
    expect(await cityOf(p.t.id)).toBe(before);
  });

  it('s42a-op-04 Test 2 · root’s canEdit hint agrees with the gate → 200, canEdit false, data unchanged', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.t.id },
    });

    const res = await getUser(p.t.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  it('s42a-op-04 Test 3 · the added feature keys are absent from every section decision', () => {
    // Structural, not a route: the claim is that neither key appears in
    // SECTION_ACCESS_MATRIX or DEFAULT_PERMISSIONS, so hasSectionAccess can
    // never consult them. A match means a feature key has entered the
    // section-access path and access-control.md line 19 is no longer
    // structurally guaranteed.
    const constantsDir = path.join(
      BACKEND_ROOT,
      'src/access-control/domain/constants',
    );
    const sources = readdirSync(constantsDir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(constantsDir, file), 'utf8'));

    for (const key of ADDED_FEATURE_KEYS) {
      expect(sources.filter((source) => source.includes(key))).toEqual([]);
    }
    for (const key of ADDED_FEATURE_KEYS) {
      expect(Object.keys(SECTION_ACCESS_MATRIX)).not.toContain(key);
    }
  });

  // E4-C04a (test-design-epic-platform-4.md): root's own card is `self`, not
  // `reporting` — the operator set gives root no relationship row of its own
  // (s42a-op-03 precondition 2 / s42b-tr-03), so the audience over root's own
  // card resolves no higher than `self`, which §3.2 row S1 gives `R`.
  it('s42a-op-04 Test 4 · root reads its own card → 200, canEdit false (self, not reporting)', async () => {
    const p = requireProvisioning();
    const row = await testApp.prisma.user.findUnique({
      where: { id: p.root.id },
    });

    const res = await getUser(p.root.id, p.root.id);

    expect(res.status).toBe(200);
    expectExactS1CardEnvelope(res.body, s1CardOf(row!), false);
  });

  // E4-C04c (PM/AD-24, CONFLICT-UM-01): the hidden-target 404 oracle
  // (`umac-11-hidden-target-denial-oracle.e2e-spec.ts`) evidenced against the
  // root persona specifically — the section-access guard resolves the hidden
  // target before any section question, so root's operator-set keys (which
  // are feature keys, not section keys) are never even in play.
  it('s42a-op-04 Test 5 · root PATCH of a missing target id → 404, not 403', async () => {
    const p = requireProvisioning();

    const res = await patchUser(uuidv7(), p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
  });

  it('s42a-op-04 Test 6 · root PATCH of an inactive target → 404, not 403, row unchanged', async () => {
    const p = requireProvisioning();
    const before = await cityOf(p.ghost.id);

    const res = await patchUser(p.ghost.id, p.root.id, { city: 'Berlin' });

    expect(res.status).toBe(404);
    expect(await cityOf(p.ghost.id)).toBe(before);
  });
});
