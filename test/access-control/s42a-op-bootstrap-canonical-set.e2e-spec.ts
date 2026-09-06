import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../src/generated/prisma/client';

// PLAT-E4-S4.2a — root-operator permission set · AD-1 Stage 2 (red E2E,
// written before any implementation code).
//
// Scenarios (one `it` per doc Test, the `s42a-op-xx` id in every title):
//   docs/test-cases/access-control-kernel/fr-bootstrap/
//     s42a-op-01-bootstrap-entrypoint-npm-alias.md
//     s42a-op-02-rerun-over-a-three-key-database-adds-only-the-new-rows.md
//
// HARNESS SHAPE (spec-4-2a § "Open item carried into the Stage-2 gate", RESOLVED
// 2026-09-06): both scenarios are DATABASE-LEVEL. They follow the plain
// `acm1r-fr-foundation.e2e-spec.ts` pattern verbatim — run the real deploy-time
// entrypoints as subprocesses (`execFile` on `npm run <script>`) and assert
// against a raw `PrismaClient`. No Nest is booted here; there is no facade call
// to make, because the subject is the deploy-time bootstrap step itself.
//
// ISOLATION (binding constraint, same section): the bootstrap mutates singleton
// global state (root identity, the one `hr-admin` FR policy) that other suites
// read, and `test:e2e` runs `--runInBand` against one shared database. The
// mechanism below is `acm1r-fr-foundation.e2e-spec.ts`'s, reused unchanged and
// NOT reinvented: `resetBootstrapState()` deletes the five bootstrap-owned
// tables in RESTRICT-safe order before every test and after the suite, and
// `deleteRunUsers()` removes this suite's own prefix-namespaced `users` rows
// (prefix-matched, not run-matched, so a run that dies before teardown does not
// leak fixtures into the shared development database).
//
// EXPECTED RED at `services/backend` HEAD ef03c88, in two SEPARABLE states:
//
//   (1) PRECONDITION-REPAIR RED — `package.json` has no
//       `db:bootstrap:access-control` key (AF-1), so `npm run` exits nonzero
//       with npm's *"Missing script"* text before the wrapper runs a single
//       statement. Every assertion that fails on `exitCode`/`Missing script`
//       belongs to this state and says NOTHING about the canonical set.
//   (2) DISCRIMINATING RED — the canonical set is three keys where these
//       scenarios require six. Every assertion that fails on a key list or a
//       cardinality (`3 !== 6`) belongs to this state.
//
// Each test asserts (1) explicitly and FIRST, with its own message, so the two
// can never be confused in the output.

// Every test shells out to the real deploy-time entrypoints; Jest's 5s default
// would abort them before their own logic ran (acm1r carries the same guard).
jest.setTimeout(120_000);

const execFileAsync = promisify(execFile);
const backendRoot = `${__dirname}/../..`;
const runId = `s42a-op-${Date.now()}-${uuidv7()}`;

/** The three keys a pre-PLAT-E4-S4.2a database was bootstrapped with. */
const PRE_CHANGE_KEYS = [
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
] as const;

/** The three keys PLAT-E4-S4.2a adds (AF-2 includes `profile:timeline:write`). */
const ADDED_KEYS = [
  'org:relationships:write',
  'employee:departure:record',
  'profile:timeline:write',
] as const;

/** The amended canonical set — six keys (spec-4-2a Code Map § "The canonical set"). */
const CANONICAL_KEYS = [...PRE_CHANGE_KEYS, ...ADDED_KEYS] as const;

/** The wrapper's own success line — `scripts/bootstrap-access-control.ts:16`. */
const BOOTSTRAP_SUCCESS_LINE =
  'Access Control bootstrap: canonical functional-role state is in place.';

type CommandRun = { exitCode: number; output: string };

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<CommandRun> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', script], {
      cwd: backendRoot,
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error: unknown) {
    const failure = error as {
      code?: number;
      stderr?: string;
      stdout?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

const runSeed = (rootWorkEmail: string) =>
  runScript('db:seed', { ROOT_WORK_EMAIL: rootWorkEmail });

const runBootstrap = (rootWorkEmail: string) =>
  runScript('db:bootstrap:access-control', { ROOT_WORK_EMAIL: rootWorkEmail });

/**
 * Separate the two red states at the point of failure. A nonzero exit whose
 * output is npm's "Missing script" text is the AF-1 precondition-repair red and
 * is asserted BEFORE any canonical-set assertion, so a suite that is red on the
 * missing alias can never be mistaken for a suite that is red on the key list.
 */
function expectBootstrapRan(run: CommandRun): void {
  if (/Missing script/i.test(run.output)) {
    throw new Error(
      'PRECONDITION-REPAIR RED (AF-1, not the canonical-set oracle): ' +
        '`npm run db:bootstrap:access-control` is not a declared npm script, ' +
        'so the bootstrap could not be invoked by name and ran no statement. ' +
        'Nothing below this line is evidence about the canonical set. ' +
        `npm output: ${run.output.trim().slice(0, 300)}`,
    );
  }
  expect(run.exitCode).toBe(0);
}

const sql = <T = unknown>(query: string, ...params: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(query, ...params);

const execSql = (query: string, ...params: unknown[]) =>
  prisma.$executeRawUnsafe(query, ...params);

async function countOf(table: string): Promise<number> {
  const [row] = await sql<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM "${table}"`,
  );
  return Number(row.n);
}

/** Teardown tolerates a missing relation (42P01) ONLY; nothing else. */
async function tolerantDelete(table: string): Promise<void> {
  try {
    await execSql(`DELETE FROM "${table}"`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (
      code !== '42P01' &&
      !/does not exist/i.test(String((error as Error).message))
    ) {
      throw error;
    }
  }
}

/** acm1r-fr-foundation.e2e-spec.ts, verbatim — RESTRICT-safe delete order. */
async function resetBootstrapState(): Promise<void> {
  for (const table of [
    'AccessControlBootstrap',
    'UserPolicies',
    'PolicyPermissions',
    'Permissions',
    'Policies',
  ]) {
    await tolerantDelete(table);
  }
}

/** acm1r-fr-foundation.e2e-spec.ts, with this suite's prefix. */
async function deleteRunUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, workEmail: true },
  });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().startsWith('s42a-op-'))
    .map(({ id }) => id);
  if (ids.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Establish the CAP-8 precondition: exactly one active normalized root User. */
async function seedRoot(
  persona = 'root',
): Promise<{ email: string; id: string }> {
  const email = emailFor(persona);
  const seed = await runSeed(email);
  expect(seed.exitCode).toBe(0);
  const user = await prisma.user.findUnique({ where: { workEmail: email } });
  expect(user).not.toBeNull();
  return { email, id: user!.id };
}

interface PermissionRow {
  id: string;
  key: string;
  description: string | null;
}

const permissionRows = () =>
  sql<PermissionRow>(
    `SELECT id, key, description FROM "Permissions" ORDER BY key`,
  );

const permissionKeys = async () =>
  (await permissionRows()).map(({ key }) => key);

async function frPolicyRow() {
  const [row] = await sql<{
    id: string;
    operator: string;
    managedBy: string;
    targetType: string | null;
    targetId: string | null;
    targetRole: string;
  }>(
    `SELECT id, operator, "managedBy", "targetType", "targetId", "targetRole"
       FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'`,
  );
  return row;
}

async function bootstrapSingleton() {
  const [row] = await sql<{
    key: string;
    normalizedRootEmail: string;
    rootUserId: string;
    policyId: string;
  }>(
    `SELECT key, "normalizedRootEmail", "rootUserId", "policyId"
       FROM "AccessControlBootstrap"`,
  );
  return row;
}

const grantPairs = () =>
  sql<{ policyId: string; permissionId: string; policyType: string }>(
    `SELECT "policyId", "permissionId", "policyType"
       FROM "PolicyPermissions" ORDER BY "permissionId"`,
  );

const userPolicyRows = () =>
  sql<{ userId: string; policyId: string }>(
    `SELECT "userId", "policyId" FROM "UserPolicies"`,
  );

beforeEach(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
});

afterAll(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
  await prisma.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-01 — the production bootstrap entrypoint is wired as an npm script
//
// Precondition repair (AF-1, John/PM 2026-09-06). This is red state (1): with
// no alias, `npm run` exits nonzero before the wrapper is reached, and EVERY
// scenario that invokes the bootstrap is red for a reason that has nothing to
// do with the canonical set.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-01 · the production bootstrap entrypoint is wired as an npm script', () => {
  it('s42a-op-01 Test 1 · the alias is declared and invokes scripts/bootstrap-access-control.ts', () => {
    // Break caught: the deploy order `db:deploy` → `db:seed` →
    // `db:bootstrap:access-control` → `start:prod` is named in six shipped
    // files; without this key none of them resolves. No behaviour is added —
    // the alias makes the documentation true.
    const pkg = JSON.parse(
      readFileSync(`${backendRoot}/package.json`, 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(Object.keys(pkg.scripts)).toContain('db:bootstrap:access-control');
    expect(pkg.scripts['db:bootstrap:access-control']).toContain(
      'scripts/bootstrap-access-control.ts',
    );
  });

  it('s42a-op-01 Test 2 · the alias resolves and runs the wrapper, leaving the canonical state', async () => {
    // Break caught: npm's "Missing script" nonzero exit is indistinguishable
    // from a real bootstrap failure to any test that asserts only a bare
    // nonzero code. The `expectBootstrapRan` guard below refuses that reading.
    const root = await seedRoot('op01');

    for (const table of [
      'Permissions',
      'Policies',
      'PolicyPermissions',
      'UserPolicies',
      'AccessControlBootstrap',
    ]) {
      expect(await countOf(table)).toBe(0);
    }

    const run = await runBootstrap(root.email);

    // ── red state (1): precondition repair. Fails FIRST and on its own message.
    expectBootstrapRan(run);
    expect(run.output).toContain(BOOTSTRAP_SUCCESS_LINE);

    // ── red state (2): the canonical set. ACM1-FB-01..04 as amended by 4.2a.
    expect(await permissionKeys()).toEqual([...CANONICAL_KEYS].sort());
    expect(await countOf('Permissions')).toBe(6);

    const policy = await frPolicyRow();
    expect(policy).toMatchObject({
      operator: '==',
      managedBy: 'admin',
      targetType: null,
      targetId: null,
      targetRole: 'hr-admin',
    });
    expect(await countOf('Policies')).toBe(1);

    const grants = await grantPairs();
    expect(grants).toHaveLength(6);
    expect(grants.every(({ policyType }) => policyType === 'FR')).toBe(true);
    expect(grants.every(({ policyId }) => policyId === policy.id)).toBe(true);

    expect(await userPolicyRows()).toEqual([
      { userId: root.id, policyId: policy.id },
    ]);
    expect(await bootstrapSingleton()).toMatchObject({
      key: 'root-hr-admin',
      rootUserId: root.id,
      policyId: policy.id,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// s42a-op-02 — a rerun over a database bootstrapped at three keys adds the
// three new rows and nothing else.
//
// FR-AMD-1 seed contract: reruns are non-destructive ensure operations. An
// absent owned row is RESTORED; an existing owned row keeps its generated id
// and its description. This is the case that decides whether the amendment is
// deployable over every already-deployed database.
// ───────────────────────────────────────────────────────────────────────────
describe('s42a-op-02 · the upgrade rerun restores three rows and preserves everything else', () => {
  it('s42a-op-02 Test · rerun over a three-key database → 6 permissions, 6 grants, every pre-existing value byte-identical', async () => {
    // Break caught: an ensure step that read the three new keys as "the catalog
    // has drifted" would fail every existing deployment on its first run after
    // the upgrade; one that rebuilt the set would reassign every id.
    const root = await seedRoot('op02');

    // ── Precondition step 2: the pre-amendment three-key state, produced by
    // the real entrypoint and then reduced to the pre-change shape. Where the
    // amended code is already present this deletes the three added rows and
    // their grants (the doc's stated equivalent starting state); at the
    // baseline commit the bootstrap seeds three keys and these deletes are
    // no-ops over the same resulting state.
    expectBootstrapRan(await runBootstrap(root.email));

    await execSql(
      `DELETE FROM "PolicyPermissions"
        WHERE "permissionId" IN (SELECT id FROM "Permissions" WHERE key = ANY($1::text[]))`,
      [...ADDED_KEYS],
    );
    await execSql(`DELETE FROM "Permissions" WHERE key = ANY($1::text[])`, [
      ...ADDED_KEYS,
    ]);

    // ── Precondition step 3: capture every value the rerun must preserve.
    const before = {
      permissions: await permissionRows(),
      grants: await grantPairs(),
      policy: await frPolicyRow(),
      attachments: await userPolicyRows(),
      singleton: await bootstrapSingleton(),
      policyCount: await countOf('Policies'),
    };

    expect(before.permissions.map(({ key }) => key)).toEqual(
      [...PRE_CHANGE_KEYS].sort(),
    );
    expect(before.grants).toHaveLength(3);
    expect(before.attachments).toHaveLength(1);
    expect(before.policyCount).toBe(1);

    // ── The amended bootstrap, over that state.
    expectBootstrapRan(await runBootstrap(root.email));

    // ── The three absent canonical keys are restored, and only those.
    const after = {
      permissions: await permissionRows(),
      grants: await grantPairs(),
      policy: await frPolicyRow(),
      attachments: await userPolicyRows(),
      singleton: await bootstrapSingleton(),
    };

    expect(after.permissions.map(({ key }) => key)).toEqual(
      [...CANONICAL_KEYS].sort(),
    );
    expect(await countOf('Permissions')).toBe(6);
    expect(after.grants).toHaveLength(6);
    expect(await countOf('PolicyPermissions')).toBe(6);
    expect(
      after.grants.filter(
        ({ policyId, policyType }) =>
          policyId === before.policy.id && policyType === 'FR',
      ),
    ).toHaveLength(6);
    expect(await countOf('Policies')).toBe(1);
    expect(await countOf('UserPolicies')).toBe(1);

    // ── Everything that existed before is byte-identical afterwards.
    const carriedOver = after.permissions.filter(({ key }) =>
      (PRE_CHANGE_KEYS as readonly string[]).includes(key),
    );
    expect(carriedOver).toEqual(before.permissions);
    expect(after.policy).toEqual(before.policy);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.singleton).toEqual(before.singleton);
    expect(
      after.grants.filter(({ permissionId }) =>
        before.grants.some((g) => g.permissionId === permissionId),
      ),
    ).toEqual(before.grants);

    // ── The three new rows carry freshly generated ids and real descriptions.
    const restored = after.permissions.filter(({ key }) =>
      (ADDED_KEYS as readonly string[]).includes(key),
    );
    expect(restored.map(({ key }) => key)).toEqual([...ADDED_KEYS].sort());
    const previousIds = before.permissions.map(({ id }) => id);
    for (const row of restored) {
      expect(previousIds).not.toContain(row.id);
      // The exact sentences are the implementation's to choose (spec-4-2a:
      // "descriptions follow the existing sentence form"); a canonical row
      // must carry one.
      expect(typeof row.description).toBe('string');
      expect((row.description ?? '').length).toBeGreaterThan(0);
    }
  });
});
