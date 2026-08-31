import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../src/generated/prisma/client';

// ACM-1R Stage 2 — CAP-3 functional-role data foundation.
//
// Scenarios: docs/test-cases/access-control-kernel/fr-bootstrap/
//   acm1-fb-01 .. acm1-fb-09    (approved workspace 9c3b450)
//   acm1r-fb-10 .. acm1r-fb-28  (approved workspace 6c77ad1)
//
// One suite over the UNION of both sets, per stories.yaml ACM-1R-tests: the
// thirteen invariants are properties of one migration, so a split Stage-2
// record could not be read as "CAP-3 is proven".
//
// Like ACM-0, CAP-3 has no facade call to make — its subject is the deploy-time
// bootstrap step. These tests execute the real production entrypoints,
// `npm run db:seed` then `npm run db:bootstrap:access-control`, against real
// migrated PostgreSQL. Prisma and raw SQL set up and inspect database facts;
// they never reproduce the bootstrap's normalization, locking, adoption, or
// drift decisions inline. Re-implementing those would prove the test rather
// than the deployed path (SPEC Constraints, "Deploy-time stories invoke their
// exact named production entrypoint").
//
// Table names are the ones database-schema.md specifies verbatim —
// "Permissions", "Policies", "PolicyPermissions", "UserPolicies",
// "AccessControlBootstrap" — and "users" for the existing User model, which
// Prisma maps to lowercase. The migration ACM-1-production writes must use
// exactly these.
//
// EXPECTED RED at this commit: none of the five tables exists, the Prisma
// schema has no FR models, and the `db:bootstrap:access-control` script is not
// defined. Every failure-path test asserts its SPECIFIC diagnostic rather than
// a bare nonzero exit, so a missing npm script cannot make a red test pass for
// the wrong reason.

const execFileAsync = promisify(execFile);
const backendRoot = `${__dirname}/../..`;
const runId = `acm1r-${Date.now()}-${uuidv7()}`;

const CANONICAL_KEYS = [
  'user-management:create',
  'user-management:deactivate',
  'user-management:list',
] as const;

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
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

const runSeed = (rootWorkEmail: string) =>
  runScript('db:seed', { ROOT_WORK_EMAIL: rootWorkEmail });

const runBootstrap = (
  rootWorkEmail: string,
  extraEnv: Record<string, string> = {},
) =>
  runScript('db:bootstrap:access-control', {
    ROOT_WORK_EMAIL: rootWorkEmail,
    ...extraEnv,
  });

const sql = <T = unknown>(query: string, ...params: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(query, ...params);

const execSql = (query: string, ...params: unknown[]) =>
  prisma.$executeRawUnsafe(query, ...params);

async function countOf(table: string): Promise<number> {
  const [row] = await sql<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM "${table}"`);
  return Number(row.n);
}

/**
 * Assert that a statement is refused BY POSTGRESQL, and by the constraint we
 * named. Matching the message matters: a bare "it threw" would also be
 * satisfied by the relation not existing, which is exactly the red state this
 * suite starts in.
 */
async function expectRejectedBy(
  statement: () => Promise<unknown>,
  matcher: RegExp,
): Promise<void> {
  let raised: unknown;
  try {
    await statement();
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeDefined();
  expect(String((raised as Error).message)).toMatch(matcher);
}

/** Teardown tolerates a missing relation (42P01) ONLY; nothing else. */
async function tolerantDelete(table: string): Promise<void> {
  try {
    await execSql(`DELETE FROM "${table}"`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42P01' && !/does not exist/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

async function resetBootstrapState(): Promise<void> {
  // Order respects the RESTRICT foreign keys the migration installs.
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

async function createFixtureUser(options: {
  workEmail: string;
  isActive?: boolean;
  position?: string;
}): Promise<string> {
  const id = uuidv7();
  await prisma.user.create({
    data: {
      id,
      firstName: 'Fixture',
      lastName: 'User',
      position: options.position ?? 'Engineer',
      country: 'PL',
      city: 'Krakow',
      workEmail: options.workEmail,
      companyJoinDate: new Date('2020-01-01'),
      isActive: options.isActive ?? true,
      createdBy: id,
    },
  });
  return id;
}

async function deleteRunUsers(): Promise<void> {
  const users = await prisma.user.findMany({ select: { id: true, workEmail: true } });
  const ids = users
    .filter(({ workEmail }) => workEmail.toLowerCase().includes(runId))
    .map(({ id }) => id);
  if (ids.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Establish the CAP-8 precondition: exactly one active normalized root User. */
async function seedRoot(persona = 'root'): Promise<{ email: string; id: string }> {
  const email = emailFor(persona);
  const seed = await runSeed(email);
  expect(seed.exitCode).toBe(0);
  const user = await prisma.user.findUnique({ where: { workEmail: email } });
  expect(user).not.toBeNull();
  return { email, id: user!.id };
}

async function frPolicyId(): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `SELECT id FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'`,
  );
  return row.id;
}

async function permissionIds(): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    `SELECT id FROM "Permissions" ORDER BY key`,
  );
  return rows.map(({ id }) => id);
}

async function insertArPolicy(targetRole = 'hr-admin'): Promise<string> {
  const id = uuidv7();
  await execSql(
    `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
     VALUES ($1, '==', 'project', $2, $3, 'AR', 'admin')`,
    id,
    uuidv7(),
    targetRole,
  );
  return id;
}

async function bootstrapSingleton() {
  const [row] = await sql<{
    key: string;
    normalizedRootEmail: string;
    rootUserId: string;
    policyId: string;
  }>(`SELECT key, "normalizedRootEmail", "rootUserId", "policyId" FROM "AccessControlBootstrap"`);
  return row;
}

beforeEach(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
});

afterAll(async () => {
  await resetBootstrapState();
  await deleteRunUsers();
  await prisma.$disconnect();
});

describe('ACM-1 CAP-3 — production entrypoint is wired', () => {
  it('exposes db:bootstrap:access-control as an npm script', async () => {
    // Break caught: without the named script every failure-path test below
    // could pass on a missing-script nonzero exit instead of on the behavior
    // it claims to prove. This test makes the red state unambiguous.
    const pkg = JSON.parse(
      readFileSync(`${backendRoot}/package.json`, 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts)).toContain('db:bootstrap:access-control');
  });
});

describe('ACM1-FB-01..07 — a fresh database ends up with exactly the canonical set', () => {
  it('ACM1-FB-01: seeds exactly the three canonical permission keys', async () => {
    // Break caught: a fourth default permission silently widens hr-admin.
    const root = await seedRoot();
    expect(await countOf('Permissions')).toBe(0);

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const rows = await sql<{ key: string }>(
      `SELECT key FROM "Permissions" ORDER BY key`,
    );
    expect(rows.map(({ key }) => key)).toEqual([...CANONICAL_KEYS].sort());
    expect(await countOf('Permissions')).toBe(3);
  });

  it('ACM1-FB-02 and ACM1-FB-07: seeds one FR hr-admin policy carrying no target', async () => {
    // Break caught: a sentinel target on the FR row makes it indistinguishable
    // from an AR row to any query that filters on targetType.
    const root = await seedRoot();

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const rows = await sql<{
      targetRole: string;
      operator: string;
      managedBy: string;
      targetType: string | null;
      targetId: string | null;
    }>(
      `SELECT "targetRole", operator, "managedBy", "targetType", "targetId"
       FROM "Policies" WHERE type = 'FR'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      targetRole: 'hr-admin',
      operator: '==',
      managedBy: 'admin',
      targetType: null,
      targetId: null,
    });
  });

  it('ACM1-FB-03: grants exactly the three seeded permissions to the role', async () => {
    // Break caught: a missing grant leaves isAllowed false for a canonical key.
    const root = await seedRoot();

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const policyId = await frPolicyId();
    const grants = await sql<{ permissionId: string; policyType: string }>(
      `SELECT "permissionId", "policyType" FROM "PolicyPermissions" WHERE "policyId" = $1`,
      policyId,
    );
    expect(grants).toHaveLength(3);
    expect(grants.every(({ policyType }) => policyType === 'FR')).toBe(true);
    expect(grants.map(({ permissionId }) => permissionId).sort()).toEqual(
      (await permissionIds()).sort(),
    );
    expect(await countOf('PolicyPermissions')).toBe(3);
  });

  it('ACM1-FB-04: attaches the one root User and records provenance', async () => {
    // Break caught: attaching without recording provenance leaves later runs
    // unable to tell a bootstrap attachment from an administrator's.
    const root = await seedRoot();

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const policyId = await frPolicyId();
    const attachments = await sql<{ userId: string; policyId: string }>(
      `SELECT "userId", "policyId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id, policyId }]);

    const singleton = await bootstrapSingleton();
    expect(singleton).toMatchObject({
      key: 'root-hr-admin',
      rootUserId: root.id,
      policyId,
    });
  });

  it('ACM1-FB-05: a rerun over an undrifted database changes nothing', async () => {
    // Break caught: a delete-and-recreate rerun reassigns every id and breaks
    // any reference taken between deployments.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const before = {
      permissions: await permissionIds(),
      policy: await frPolicyId(),
      singleton: await bootstrapSingleton(),
    };

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await permissionIds()).toEqual(before.permissions);
    expect(await frPolicyId()).toEqual(before.policy);
    expect(await bootstrapSingleton()).toEqual(before.singleton);
    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('PolicyPermissions')).toBe(3);
    expect(await countOf('UserPolicies')).toBe(1);
  });

  it('ACM1-FB-06: creates no other role, attachment, or default grant', async () => {
    // Break caught: a default AR policy or a second attachment grants access
    // nobody approved.
    const root = await seedRoot();
    await createFixtureUser({ workEmail: emailFor('bystander') });

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('Policies')).toBe(1);
    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('PolicyPermissions')).toBe(3);
    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
  });
});

describe('ACM1-FB-08 and ACM1R-FB-10 — Policies row shape and the partial FR role key', () => {
  it('ACM1-FB-08: rejects both malformed shapes, a null type, and a third type value', async () => {
    // Break caught: application-only shape validation lets any other writer
    // insert an FR row with a target.
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
           VALUES ($1, '==', 'project', $2, 'hr-admin', 'FR', 'admin')`,
          uuidv7(),
          uuidv7(),
        ),
      /violates check constraint|check constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
           VALUES ($1, '==', NULL, NULL, 'ac-manager', 'AR', 'admin')`,
          uuidv7(),
        ),
      /violates check constraint|check constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Policies" (id, operator, "targetRole", type, "managedBy")
           VALUES ($1, '==', 'hr-admin', NULL, 'admin')`,
          uuidv7(),
        ),
      /null value in column "type"|not-null constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Policies" (id, operator, "targetRole", type, "managedBy")
           VALUES ($1, '==', 'hr-admin', 'SOMETHING_ELSE', 'admin')`,
          uuidv7(),
        ),
      /check constraint|invalid input value for enum/i,
    );
    expect(await countOf('Policies')).toBe(0);
  });

  it('ACM1R-FB-10: rejects a second FR hr-admin row but ACCEPTS an AR row with the same targetRole', async () => {
    // Break caught: a non-partial unique index would reject the AR row too,
    // making a legal, different object impossible to store.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
           VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'admin')`,
          uuidv7(),
        ),
      /duplicate key value|unique constraint/i,
    );
    expect(
      await countOf('Policies'),
    ).toBe(1);

    const arId = await insertArPolicy('hr-admin');
    const arRows = await sql<{ id: string }>(
      `SELECT id FROM "Policies" WHERE type = 'AR' AND "targetRole" = 'hr-admin'`,
    );
    expect(arRows).toEqual([{ id: arId }]);
  });
});

describe('ACM1R-FB-11 — the grant table type separation is a database boundary', () => {
  it('exposes the Policies(id, type) support key and references it from the composite FK', async () => {
    // Break caught: referencing Policies(id) alone cannot constrain the type,
    // so the discriminator becomes decorative.
    const supportKeys = await sql<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"Policies"'::regclass AND contype = 'u'
         AND (SELECT array_agg(attname ORDER BY attname)
              FROM pg_attribute
              WHERE attrelid = conrelid AND attnum = ANY(conkey)) = ARRAY['id','type']`,
    );
    expect(supportKeys.length).toBeGreaterThan(0);

    const compositeFks = await sql<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"PolicyPermissions"'::regclass AND contype = 'f'
         AND confrelid = '"Policies"'::regclass
         AND array_length(conkey, 1) = 2`,
    );
    expect(compositeFks.length).toBeGreaterThan(0);
  });

  it('defaults policyType to FR, rejects any other value, and refuses an AR-policy grant', async () => {
    // Break caught: this is the ONLY path by which an AR policy could acquire
    // a functional permission. It must close in PostgreSQL, not in the seed —
    // the grant table is reachable without the seed.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();
    const arPolicyId = await insertArPolicy('hr-admin');

    const extraPermissionId = uuidv7();
    await execSql(
      `INSERT INTO "Permissions" (id, key, description) VALUES ($1, $2, 'extra')`,
      extraPermissionId,
      `user-management:export-${runId}`,
    );

    await execSql(
      `INSERT INTO "PolicyPermissions" ("policyId", "permissionId") VALUES ($1, $2)`,
      policyId,
      extraPermissionId,
    );
    const [defaulted] = await sql<{ policyType: string }>(
      `SELECT "policyType" FROM "PolicyPermissions"
       WHERE "policyId" = $1 AND "permissionId" = $2`,
      policyId,
      extraPermissionId,
    );
    expect(defaulted.policyType).toBe('FR');

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "PolicyPermissions" ("policyId", "permissionId", "policyType")
           VALUES ($1, $2, 'AR')`,
          arPolicyId,
          extraPermissionId,
        ),
      /check constraint/i,
    );

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "PolicyPermissions" ("policyId", "permissionId", "policyType")
           VALUES ($1, $2, 'FR')`,
          arPolicyId,
          extraPermissionId,
        ),
      /foreign key constraint/i,
    );

    const arGrants = await sql<{ policyId: string }>(
      `SELECT "policyId" FROM "PolicyPermissions" WHERE "policyId" = $1`,
      arPolicyId,
    );
    expect(arGrants).toEqual([]);
  });
});

describe('ACM1-FB-09, ACM1R-FB-12, ACM1R-FB-13 — uniqueness, references, and the hot-path index', () => {
  it('ACM1-FB-09: rejects a duplicate permission key, grant pair, and attachment', async () => {
    // Break caught: duplicate grants and attachments make cardinality
    // assertions elsewhere in this suite meaningless.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();
    const [firstPermissionId] = await permissionIds();

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "Permissions" (id, key, description) VALUES ($1, $2, 'dup')`,
          uuidv7(),
          CANONICAL_KEYS[0],
        ),
      /duplicate key value|unique constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "PolicyPermissions" ("policyId", "permissionId") VALUES ($1, $2)`,
          policyId,
          firstPermissionId,
        ),
      /duplicate key value|unique constraint|primary key/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
          root.id,
          policyId,
        ),
      /duplicate key value|unique constraint|primary key/i,
    );

    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('PolicyPermissions')).toBe(3);
    expect(await countOf('UserPolicies')).toBe(1);
  });

  it('ACM1R-FB-12: rejects a grant to an unknown permission and exposes the permission-first index', async () => {
    // Break caught: a (policyId, permissionId) index is already provided by the
    // primary key. Only the permission-FIRST order makes ACM-2's evaluation,
    // which enters from a permission key, an index seek rather than a scan.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "PolicyPermissions" ("policyId", "permissionId") VALUES ($1, $2)`,
          policyId,
          uuidv7(),
        ),
      /foreign key constraint/i,
    );
    expect(await countOf('PolicyPermissions')).toBe(3);

    const indexes = await sql<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'PolicyPermissions'`,
    );
    const permissionFirst = indexes.filter(({ indexdef }) =>
      /\(\s*"?permissionId"?\s*,\s*"?policyId"?\s*\)/i.test(indexdef),
    );
    expect(permissionFirst.length).toBeGreaterThan(0);
  });

  it('ACM1R-FB-13: rejects an attachment naming an unknown user or an unknown policy', async () => {
    // Break caught: an orphan attachment is a grant to nobody that still
    // occupies the (userId, policyId) key the bootstrap reasons about.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
          uuidv7(),
          policyId,
        ),
      /foreign key constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
          root.id,
          uuidv7(),
        ),
      /foreign key constraint/i,
    );
    expect(await countOf('UserPolicies')).toBe(1);
  });
});

describe('ACM1R-FB-14 — AccessControlBootstrap is a constrained singleton', () => {
  it('rejects a second singleton, a wrong key, and a duplicate reference', async () => {
    // Break caught: without the CHECK, the primary key alone permits an
    // unbounded family of bootstrap rows under other keys, and "no singleton
    // recorded" stops meaning "no provenance exists".
    const root = await seedRoot();
    const other = await createFixtureUser({ workEmail: emailFor('other-admin') });
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();

    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "AccessControlBootstrap" (key, "normalizedRootEmail", "rootUserId", "policyId")
           VALUES ('root-hr-admin', $1, $2, $3)`,
          emailFor('second-singleton'),
          other,
          policyId,
        ),
      /duplicate key value|unique constraint|primary key/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "AccessControlBootstrap" (key, "normalizedRootEmail", "rootUserId", "policyId")
           VALUES ('another-bootstrap', $1, $2, $3)`,
          emailFor('wrong-key'),
          other,
          policyId,
        ),
      /check constraint/i,
    );
    await expectRejectedBy(
      () =>
        execSql(
          `INSERT INTO "AccessControlBootstrap" (key, "normalizedRootEmail", "rootUserId", "policyId")
           VALUES ('root-hr-admin', $1, $2, $3)`,
          emailFor('dup-root-ref'),
          root.id,
          policyId,
        ),
      /duplicate key value|unique constraint|primary key/i,
    );

    expect(await countOf('AccessControlBootstrap')).toBe(1);
  });
});

describe('ACM1R-FB-15 — ON DELETE RESTRICT on all four functional-role-side foreign keys', () => {
  it('refuses to delete a granted permission, a granted policy, an attached user, or a referenced row', async () => {
    // Break caught: SPEC CAP-4 relies on orphaned FR grant rows being
    // unreachable in supported operation. That claim is load-bearing for
    // ACM-2's acceptance and is asserted nowhere else.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();
    const [permissionId] = await permissionIds();

    await expectRejectedBy(
      () => execSql(`DELETE FROM "Permissions" WHERE id = $1`, permissionId),
      /foreign key constraint|still referenced/i,
    );
    await expectRejectedBy(
      () => execSql(`DELETE FROM "Policies" WHERE id = $1`, policyId),
      /foreign key constraint|still referenced/i,
    );
    await expectRejectedBy(
      () => execSql(`DELETE FROM "users" WHERE id = $1`, root.id),
      /foreign key constraint|still referenced/i,
    );

    // The singleton's own references, isolated from the grant references above.
    await execSql(`DELETE FROM "PolicyPermissions"`);
    await execSql(`DELETE FROM "UserPolicies"`);
    await expectRejectedBy(
      () => execSql(`DELETE FROM "Policies" WHERE id = $1`, policyId),
      /foreign key constraint|still referenced/i,
    );
    await expectRejectedBy(
      () => execSql(`DELETE FROM "users" WHERE id = $1`, root.id),
      /foreign key constraint|still referenced/i,
    );

    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('Policies')).toBe(1);
    expect(await countOf('AccessControlBootstrap')).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: root.id } })).toMatchObject({
      isActive: true,
    });
  });
});

describe('ACM1R-FB-16 — a renamed canonical key is absent, not different', () => {
  it('restores the canonical row and preserves the renamed one, issuing no in-place key update', async () => {
    // Break caught: renaming the row back would be the in-place key update
    // append-only forbids, and would destroy whatever the -v2 key was for.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const renamedKey = `${CANONICAL_KEYS[0]}-v2`;
    await execSql(
      `UPDATE "Permissions" SET key = $1 WHERE key = $2`,
      renamedKey,
      CANONICAL_KEYS[0],
    );
    const [{ id: renamedId }] = await sql<{ id: string }>(
      `SELECT id FROM "Permissions" WHERE key = $1`,
      renamedKey,
    );

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('Permissions')).toBe(4);
    const [restored] = await sql<{ id: string }>(
      `SELECT id FROM "Permissions" WHERE key = $1`,
      CANONICAL_KEYS[0],
    );
    expect(restored.id).not.toBe(renamedId);

    const [stillRenamed] = await sql<{ id: string }>(
      `SELECT id FROM "Permissions" WHERE key = $1`,
      renamedKey,
    );
    expect(stillRenamed.id).toBe(renamedId);

    expect(await countOf('PolicyPermissions')).toBe(4);
    const preserved = await sql<{ permissionId: string }>(
      `SELECT "permissionId" FROM "PolicyPermissions" WHERE "permissionId" = $1`,
      renamedId,
    );
    expect(preserved).toHaveLength(1);
  });
});

describe('ACM1R-FB-17 — DEC-UM-007 normalization at lookup', () => {
  it('resolves a whitespace- and case-variant ROOT_WORK_EMAIL and persists the normalized form', async () => {
    // Break caught: storing the raw configured string makes the ACM1R-FB-23
    // drift comparison whitespace- and case-sensitive, so reformatting an
    // environment variable would read as conflicting bootstrap drift.
    const root = await seedRoot('normalized');
    const populationBefore = await prisma.user.count();

    const run = await runBootstrap(`  ${root.email.toUpperCase()}  `);
    expect(run.exitCode).toBe(0);

    const singleton = await bootstrapSingleton();
    expect(singleton.normalizedRootEmail).toBe(root.email);
    expect(singleton.rootUserId).toBe(root.id);

    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
    expect(await prisma.user.count()).toBe(populationBefore);
    expect(
      await prisma.user.findUnique({ where: { id: root.id } }),
    ).toMatchObject({ workEmail: root.email });
  });
});

describe('ACM1R-FB-18 — the common advisory lock covers first creation', () => {
  it('blocks on a held lock from an empty database and times out with an actionable diagnostic', async () => {
    // Break caught: locking the singleton ROW acquires nothing on a fresh
    // database, so two concurrent first runs would race straight past each
    // other. Only an advisory lock taken before any state inspection serializes
    // first creation.
    const root = await seedRoot();
    expect(await countOf('AccessControlBootstrap')).toBe(0);

    const holder = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
    });
    try {
      const held = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended('access-control:bootstrap:root-hr-admin', 0))`,
        );
        const run = await runBootstrap(root.email, {
          ACCESS_CONTROL_BOOTSTRAP_LOCK_TIMEOUT_MS: '2000',
        });
        return run;
      });
      const run = await held;

      expect(run.exitCode).not.toBe(0);
      expect(run.output).toMatch(/lock/i);
      expect(run.output).toMatch(/timeout|timed out|could not obtain/i);
    } finally {
      await holder.$disconnect();
    }

    expect(await countOf('Permissions')).toBe(0);
    expect(await countOf('Policies')).toBe(0);
    expect(await countOf('PolicyPermissions')).toBe(0);
    expect(await countOf('UserPolicies')).toBe(0);
    expect(await countOf('AccessControlBootstrap')).toBe(0);

    // After the lock is released the same command completes normally.
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    expect(await countOf('Permissions')).toBe(3);
  });
});

describe('ACM1R-FB-19 — revalidation before writes and again before commit', () => {
  it('rolls back when the root is deactivated inside the transaction window', async () => {
    // Break caught: without the pre-commit check, everything between the first
    // eligibility read and commit is a window in which the root identity can
    // change underneath a transaction that is about to grant it three
    // permissions.
    const root = await seedRoot();

    const run = await runBootstrap(root.email, {
      ACCESS_CONTROL_BOOTSTRAP_TEST_HOOK: 'deactivate-root-before-commit',
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/root identity|eligibility|no longer/i);

    expect(await countOf('Permissions')).toBe(0);
    expect(await countOf('Policies')).toBe(0);
    expect(await countOf('PolicyPermissions')).toBe(0);
    expect(await countOf('UserPolicies')).toBe(0);
    expect(await countOf('AccessControlBootstrap')).toBe(0);
  });
});

describe('ACM1R-FB-20..22 — with no singleton, adoption is permitted', () => {
  it('ACM1R-FB-20 A: adopts a canonically shaped existing FR hr-admin policy by natural key', async () => {
    // Break caught: creating a second FR row is impossible under the partial
    // index, so a bootstrap that does not adopt simply crashes on rerun.
    const root = await seedRoot();
    const existingPolicyId = uuidv7();
    await execSql(
      `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
       VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'admin')`,
      existingPolicyId,
    );

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('Policies')).toBe(1);
    expect(await frPolicyId()).toBe(existingPolicyId);
    expect((await bootstrapSingleton()).policyId).toBe(existingPolicyId);
    expect(await countOf('PolicyPermissions')).toBe(3);
    const attachments = await sql<{ policyId: string }>(
      `SELECT "policyId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ policyId: existingPolicyId }]);
  });

  it('ACM1R-FB-20 B: refuses adoption when managedBy drifts, writing nothing', async () => {
    // Break caught: adoption by natural key alone inherits whatever the row
    // says — including sync provenance reserved to the timetracker.
    const root = await seedRoot();
    const driftedId = uuidv7();
    await execSql(
      `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
       VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'sync')`,
      driftedId,
    );

    const run = await runBootstrap(root.email);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/managedBy/i);

    const [row] = await sql<{ managedBy: string }>(
      `SELECT "managedBy" FROM "Policies" WHERE id = $1`,
      driftedId,
    );
    expect(row.managedBy).toBe('sync');
    expect(await countOf('PolicyPermissions')).toBe(0);
    expect(await countOf('UserPolicies')).toBe(0);
    expect(await countOf('AccessControlBootstrap')).toBe(0);
  });

  it('ACM1R-FB-21 A: adopts an existing attachment that already belongs to the located root', async () => {
    // Break caught: creating a second attachment is impossible under the
    // (userId, policyId) key; not adopting means crashing.
    const root = await seedRoot();
    const policyId = uuidv7();
    await execSql(
      `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
       VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'admin')`,
      policyId,
    );
    await execSql(
      `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
      root.id,
      policyId,
    );

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('UserPolicies')).toBe(1);
    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
    expect((await bootstrapSingleton()).rootUserId).toBe(root.id);
  });

  it('ACM1R-FB-21 B: never adopts or transfers attachments belonging to other administrators', async () => {
    // Break caught: rewriting an administrator's attachment to point at the
    // configured root silently revokes a real person's access.
    const root = await seedRoot();
    const nadia = await createFixtureUser({ workEmail: emailFor('nadia') });
    const piotr = await createFixtureUser({ workEmail: emailFor('piotr') });
    const policyId = uuidv7();
    await execSql(
      `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
       VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'admin')`,
      policyId,
    );
    for (const userId of [nadia, piotr]) {
      await execSql(
        `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
        userId,
        policyId,
      );
    }

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" ORDER BY "userId"`,
    );
    expect(attachments.map(({ userId }) => userId).sort()).toEqual(
      [nadia, piotr, root.id].sort(),
    );
    expect((await bootstrapSingleton()).rootUserId).toBe(root.id);
  });

  it('ACM1R-FB-22: adopts a changed configured root when nothing recorded provenance', async () => {
    // Break caught: treating a changed root as drift with no singleton present
    // would make a first bootstrap impossible on any database an administrator
    // had already touched.
    const olga = await createFixtureUser({ workEmail: emailFor('olga') });
    const rita = await seedRoot('rita');
    const policyId = uuidv7();
    await execSql(
      `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
       VALUES ($1, '==', NULL, NULL, 'hr-admin', 'FR', 'admin')`,
      policyId,
    );
    await execSql(
      `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
      olga,
      policyId,
    );

    expect((await runBootstrap(rita.email)).exitCode).toBe(0);

    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" ORDER BY "userId"`,
    );
    expect(attachments.map(({ userId }) => userId).sort()).toEqual(
      [olga, rita.id].sort(),
    );
    const singleton = await bootstrapSingleton();
    expect(singleton.rootUserId).toBe(rita.id);
    expect(singleton.normalizedRootEmail).toBe(rita.email);
  });
});

describe('ACM1R-FB-23 — with the singleton present, a changed root email is conflicting drift', () => {
  it('fails before writes, transferring nothing and adding no second root attachment', async () => {
    // Break caught: Rita is a VALID, unambiguous, active root candidate. The
    // run must still fail — the cause is the recorded provenance disagreeing,
    // not anything wrong with Rita. Paired with ACM1R-FB-22, this is the whole
    // of the deliberate asymmetry.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const before = await bootstrapSingleton();

    const rita = await seedRoot('rita');

    const run = await runBootstrap(rita.email);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/drift|conflicting/i);
    expect(run.output).toContain(root.email);
    expect(run.output).toContain(rita.email);

    expect(await bootstrapSingleton()).toEqual(before);
    expect(await countOf('UserPolicies')).toBe(1);
    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
    const ritaAttachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" WHERE "userId" = $1`,
      rita.id,
    );
    expect(ritaAttachments).toEqual([]);
    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('PolicyPermissions')).toBe(3);
  });
});

describe('ACM1R-FB-24 — an AR hr-admin policy is invisible to the bootstrap', () => {
  it('is neither adopted, mutated, counted, nor reported as drift', async () => {
    // Break caught: all four failure modes — adoption, mutation, miscounting,
    // false drift — come from matching on targetRole alone rather than on the
    // (targetRole, type) pair the partial index actually scopes.
    const root = await seedRoot();
    const piotr = await createFixtureUser({ workEmail: emailFor('piotr') });
    const arPolicyId = await insertArPolicy('hr-admin');
    const arBefore = await sql<Record<string, unknown>>(
      `SELECT id, type, operator, "managedBy", "targetType", "targetId", "targetRole"
       FROM "Policies" WHERE id = $1`,
      arPolicyId,
    );
    await execSql(
      `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
      piotr,
      arPolicyId,
    );

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const frRows = await sql<{ id: string }>(
      `SELECT id FROM "Policies" WHERE type = 'FR' AND "targetRole" = 'hr-admin'`,
    );
    expect(frRows).toHaveLength(1);
    expect(frRows[0].id).not.toBe(arPolicyId);

    const arAfter = await sql<Record<string, unknown>>(
      `SELECT id, type, operator, "managedBy", "targetType", "targetId", "targetRole"
       FROM "Policies" WHERE id = $1`,
      arPolicyId,
    );
    expect(arAfter).toEqual(arBefore);

    expect((await bootstrapSingleton()).policyId).toBe(frRows[0].id);
    const arGrants = await sql<{ policyId: string }>(
      `SELECT "policyId" FROM "PolicyPermissions" WHERE "policyId" = $1`,
      arPolicyId,
    );
    expect(arGrants).toEqual([]);
    const arAttachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" WHERE "policyId" = $1`,
      arPolicyId,
    );
    expect(arAttachments).toEqual([{ userId: piotr }]);
    const frAttachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" WHERE "policyId" = $1`,
      frRows[0].id,
    );
    expect(frAttachments).toEqual([{ userId: root.id }]);
  });
});

describe('ACM1R-FB-25 — concurrent runs', () => {
  it('A: two identical first runs converge on exactly one bootstrap set', async () => {
    // Break caught: without the advisory lock both read "empty", both insert,
    // and one dies on the partial FR unique index having already written
    // permissions.
    const root = await seedRoot();

    const [first, second] = await Promise.all([
      runBootstrap(root.email),
      runBootstrap(root.email),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('Policies')).toBe(1);
    expect(await countOf('PolicyPermissions')).toBe(3);
    expect(await countOf('UserPolicies')).toBe(1);
    expect(await countOf('AccessControlBootstrap')).toBe(1);
  });

  it('B: two runs with different configured roots leave one coherent set and one atomic failure', async () => {
    // Break caught: the loser must fail rather than corrupt the winner's set.
    // Which process wins is deliberately not asserted.
    const rootA = await seedRoot('race-a');
    const rootB = await seedRoot('race-b');

    const [first, second] = await Promise.all([
      runBootstrap(rootA.email),
      runBootstrap(rootB.email),
    ]);

    const exitCodes = [first.exitCode, second.exitCode].sort();
    expect(exitCodes[0]).toBe(0);
    expect(exitCodes[1]).not.toBe(0);
    const loser = first.exitCode === 0 ? second : first;
    expect(loser.output).toMatch(/drift|conflicting/i);

    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('Policies')).toBe(1);
    expect(await countOf('PolicyPermissions')).toBe(3);
    expect(await countOf('UserPolicies')).toBe(1);
    expect(await countOf('AccessControlBootstrap')).toBe(1);

    const singleton = await bootstrapSingleton();
    const [attachment] = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachment.userId).toBe(singleton.rootUserId);
  });
});

describe('ACM1R-FB-26 — drift is dispositioned per field', () => {
  it('R1: restores a deleted canonical grant', async () => {
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();
    const [permissionId] = await permissionIds();
    await execSql(
      `DELETE FROM "PolicyPermissions" WHERE "policyId" = $1 AND "permissionId" = $2`,
      policyId,
      permissionId,
    );
    expect(await countOf('PolicyPermissions')).toBe(2);

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('PolicyPermissions')).toBe(3);
  });

  it('R2: restores a deleted root attachment for the RECORDED root', async () => {
    // Break caught: deleting the attachment does not license re-selecting a
    // root — the drift table restores it "only while it still matches".
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    await execSql(`DELETE FROM "UserPolicies"`);

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
  });

  it('P1: preserves an edited permission description', async () => {
    // Break caught: descriptive text is not authorization-bearing; restoring
    // it would silently revert an administrator's edit for no benefit.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    await execSql(
      `UPDATE "Permissions" SET description = 'edited by an administrator' WHERE key = $1`,
      CANONICAL_KEYS[0],
    );

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    const [row] = await sql<{ description: string }>(
      `SELECT description FROM "Permissions" WHERE key = $1`,
      CANONICAL_KEYS[0],
    );
    expect(row.description).toBe('edited by an administrator');
  });

  it('P2: preserves every generated id across a rerun', async () => {
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const before = { permissions: await permissionIds(), policy: await frPolicyId() };

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await permissionIds()).toEqual(before.permissions);
    expect(await frPolicyId()).toBe(before.policy);
  });

  it.each([
    ['F1', 'operator', `UPDATE "Policies" SET operator = 'IN' WHERE type = 'FR'`, /operator/i],
    ['F2', 'managedBy', `UPDATE "Policies" SET "managedBy" = 'sync' WHERE type = 'FR'`, /managedBy/i],
  ])(
    '%s: fails before writes when the FR policy\'s %s drifts',
    async (_case, _field, mutation, diagnostic) => {
      // Break caught: rewriting a drifted operator would let the seed change an
      // authorization predicate with no approval.
      const root = await seedRoot();
      expect((await runBootstrap(root.email)).exitCode).toBe(0);
      await execSql(mutation);
      const snapshot = {
        permissions: await countOf('Permissions'),
        grants: await countOf('PolicyPermissions'),
        attachments: await countOf('UserPolicies'),
        singleton: await bootstrapSingleton(),
      };

      const run = await runBootstrap(root.email);

      expect(run.exitCode).not.toBe(0);
      expect(run.output).toMatch(diagnostic);
      expect(await countOf('Permissions')).toBe(snapshot.permissions);
      expect(await countOf('PolicyPermissions')).toBe(snapshot.grants);
      expect(await countOf('UserPolicies')).toBe(snapshot.attachments);
      expect(await bootstrapSingleton()).toEqual(snapshot.singleton);
    },
  );

  it('F3: fails when the singleton policyId no longer names the canonical FR policy', async () => {
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const arPolicyId = await insertArPolicy('ac-manager');
    await execSql(
      `UPDATE "AccessControlBootstrap" SET "policyId" = $1`,
      arPolicyId,
    );

    const run = await runBootstrap(root.email);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/polic/i);
    expect((await bootstrapSingleton()).policyId).toBe(arPolicyId);
  });

  it('F4: fails when the singleton rootUserId names someone other than the located root', async () => {
    // Break caught: transferring the attachment here would move the functional
    // role onto whoever the singleton was edited to name.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const other = await createFixtureUser({ workEmail: emailFor('impostor') });
    await execSql(`UPDATE "AccessControlBootstrap" SET "rootUserId" = $1`, other);

    const run = await runBootstrap(root.email);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/root/i);
    expect(await countOf('UserPolicies')).toBe(1);
    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies"`,
    );
    expect(attachments).toEqual([{ userId: root.id }]);
  });
});

describe('ACM1R-FB-27 — a failure after writes leaves no partial state', () => {
  it('rolls back everything written before an injected pre-commit failure', async () => {
    // Break caught: every other "nothing written" assertion in this suite
    // detects its failure BEFORE the first write, so none of them can tell one
    // real transaction from a sequence of autocommitted statements. Placing the
    // failure after writes is the only arrangement that distinguishes them.
    //
    // A partial bootstrap is specifically dangerous: three permissions and an
    // FR policy with no grants and no attachment is a state in which isAllowed
    // returns false for a root who appears, to an operator reading the tables,
    // to have been provisioned.
    const root = await seedRoot();

    const run = await runBootstrap(root.email, {
      ACCESS_CONTROL_BOOTSTRAP_TEST_HOOK: 'fail-after-permissions-before-commit',
    });

    expect(run.exitCode).not.toBe(0);
    expect(await countOf('Permissions')).toBe(0);
    expect(await countOf('Policies')).toBe(0);
    expect(await countOf('PolicyPermissions')).toBe(0);
    expect(await countOf('UserPolicies')).toBe(0);
    expect(await countOf('AccessControlBootstrap')).toBe(0);

    // The rollback left no poisoned state: a clean run still succeeds.
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    expect(await countOf('Permissions')).toBe(3);
    expect(await countOf('PolicyPermissions')).toBe(3);
    expect(await countOf('UserPolicies')).toBe(1);
  });
});

describe('ACM1R-FB-28 — administrator additions survive a rerun', () => {
  it('preserves an approved fourth permission, its grant, and a later attachment', async () => {
    // Break caught: verifying the policy's grants by comparing its FULL grant
    // set against the canonical three would delete the fourth. The correct
    // check is that the three canonical pairs are PRESENT, not that they are
    // the only ones.
    const root = await seedRoot();
    expect((await runBootstrap(root.email)).exitCode).toBe(0);
    const policyId = await frPolicyId();

    const fourthId = uuidv7();
    const fourthKey = `user-management:export-${runId}`;
    await execSql(
      `INSERT INTO "Permissions" (id, key, description) VALUES ($1, $2, 'approved fourth')`,
      fourthId,
      fourthKey,
    );
    await execSql(
      `INSERT INTO "PolicyPermissions" ("policyId", "permissionId") VALUES ($1, $2)`,
      policyId,
      fourthId,
    );
    const nadia = await createFixtureUser({ workEmail: emailFor('nadia') });
    await execSql(
      `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
      nadia,
      policyId,
    );

    const singletonBefore = await bootstrapSingleton();

    expect((await runBootstrap(root.email)).exitCode).toBe(0);

    expect(await countOf('Permissions')).toBe(4);
    const [fourth] = await sql<{ id: string }>(
      `SELECT id FROM "Permissions" WHERE key = $1`,
      fourthKey,
    );
    expect(fourth.id).toBe(fourthId);
    expect(await countOf('PolicyPermissions')).toBe(4);
    expect(await countOf('UserPolicies')).toBe(2);
    const attachments = await sql<{ userId: string }>(
      `SELECT "userId" FROM "UserPolicies" ORDER BY "userId"`,
    );
    expect(attachments.map(({ userId }) => userId).sort()).toEqual(
      [nadia, root.id].sort(),
    );
    expect(await bootstrapSingleton()).toEqual(singletonBefore);
  });
});
