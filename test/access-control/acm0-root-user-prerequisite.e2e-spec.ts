import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../src/generated/prisma/client';

// Scenarios: docs/test-cases/access-control-kernel/root-user-prerequisite/
// acm0-ru-root-user-prerequisite.md
//
// ACM-0 is a deploy-time prerequisite rather than a facade operation. These
// tests deliberately execute `npm run db:seed`, the production entrypoint,
// against real migrated PostgreSQL. Prisma is used only to set up and inspect
// isolated database facts; it never reproduces the seed's decisions inline.

const execFileAsync = promisify(execFile);
const backendRoot = `${__dirname}/../..`;
const runId = `acm0-${Date.now()}-${uuidv7()}`;

type SeedRun = {
  exitCode: number;
  output: string;
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  }),
});

const emailFor = (persona: string) => `${runId}-${persona}@company.example`;

async function runSeed(rootWorkEmail: string): Promise<SeedRun> {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', 'db:seed'], {
      cwd: backendRoot,
      env: { ...process.env, ROOT_WORK_EMAIL: rootWorkEmail },
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

describe('ACM-0 — deploy-time root User prerequisite (migrated PostgreSQL)', () => {
  afterEach(async () => {
    await prisma.user.deleteMany({
      where: { workEmail: { contains: runId } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('stores the trimmed, lowercase root email rather than the configured raw value', async () => {
    // Break caught: persisting ROOT_WORK_EMAIL verbatim leaves a noncanonical
    // row and defeats the writer-side normalized-identity guarantee.
    const canonicalEmail = emailFor('canonical-storage');
    const seed = await runSeed(`  ${canonicalEmail.toUpperCase()}  `);

    expect(seed.exitCode).toBe(0);

    const rows = await prisma.user.findMany({
      where: { workEmail: { contains: runId } },
      select: { workEmail: true, isActive: true },
    });
    expect(rows).toEqual([{ workEmail: canonicalEmail, isActive: true }]);
  });

  it('matches a canonical root across case and whitespace while ignoring unrelated active employees', async () => {
    // Break caught: raw-only lookup creates a second root identity on a rerun.
    const canonicalEmail = emailFor('normalized-match');
    await createFixtureUser({ workEmail: emailFor('unrelated-a') });
    await createFixtureUser({ workEmail: emailFor('unrelated-b') });

    expect((await runSeed(canonicalEmail)).exitCode).toBe(0);
    expect(
      (await runSeed(`  ${canonicalEmail.toUpperCase()}  `)).exitCode,
    ).toBe(0);

    const matchingRows = await prisma.user.findMany({
      where: { workEmail: { contains: runId } },
      select: { id: true, workEmail: true, isActive: true },
    });
    const rootMatches = matchingRows.filter(
      ({ workEmail }) => workEmail.trim().toLowerCase() === canonicalEmail,
    );

    expect(rootMatches).toHaveLength(1);
    expect(rootMatches[0]).toMatchObject({
      workEmail: canonicalEmail,
      isActive: true,
    });
    expect(matchingRows).toHaveLength(3);
  });

  it('rejects a whitespace-only ROOT_WORK_EMAIL with an actionable diagnostic and no User write', async () => {
    // Break caught: treating whitespace as configured silently creates a bad
    // identity instead of halting deployment.
    const seed = await runSeed('   ');

    expect(seed.exitCode).not.toBe(0);
    expect(seed.output).toMatch(/ROOT_WORK_EMAIL/i);
    expect(seed.output).toMatch(/blank|nonblank|required/i);
    expect(
      await prisma.user.count({ where: { workEmail: { contains: runId } } }),
    ).toBe(0);
  });

  it('rejects an unmatched configured identity instead of adopting an existing HR Admin fallback', async () => {
    // Break caught: selecting by position or first user mutates an unrelated
    // employee and hides an operator configuration error.
    const existingId = await createFixtureUser({
      workEmail: emailFor('existing-hr-admin'),
      position: 'HR Admin',
    });
    const unmatchedEmail = emailFor('unmatched-root');

    const seed = await runSeed(unmatchedEmail);

    expect(seed.exitCode).not.toBe(0);
    expect(seed.output).toMatch(/unmatched root identity/i);
    expect(seed.output).toContain(unmatchedEmail);
    expect(seed.output).toMatch(/0/);
    expect(
      await prisma.user.findUnique({ where: { id: existingId } }),
    ).toMatchObject({
      workEmail: emailFor('existing-hr-admin'),
      isActive: true,
      position: 'HR Admin',
    });
  });

  it('reports ambiguous normalized identities before consulting active state', async () => {
    // Break caught: filtering inactive rows before cardinality would select the
    // live row and conceal a case-only duplicate identity.
    const canonicalEmail = emailFor('ambiguous-root');
    await createFixtureUser({ workEmail: canonicalEmail, isActive: true });
    await createFixtureUser({
      workEmail: canonicalEmail.toUpperCase(),
      isActive: false,
    });

    const seed = await runSeed(canonicalEmail);

    expect(seed.exitCode).not.toBe(0);
    expect(seed.output).toMatch(/ambiguous root identity/i);
    expect(seed.output).toContain(canonicalEmail);
    expect(seed.output).toMatch(/2/);

    const rows = await prisma.user.findMany({
      where: { workEmail: { contains: runId } },
      select: { workEmail: true, isActive: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { workEmail: canonicalEmail, isActive: true },
        { workEmail: canonicalEmail.toUpperCase(), isActive: false },
      ]),
    );
  });

  it('rejects the one inactive normalized match without reactivating or mutating it', async () => {
    // Break caught: accepting or reactivating a deactivated identity changes
    // lifecycle state without an approved rehire command.
    const canonicalEmail = emailFor('inactive-root');
    const inactiveId = await createFixtureUser({
      workEmail: canonicalEmail,
      isActive: false,
    });

    const seed = await runSeed(canonicalEmail);

    expect(seed.exitCode).not.toBe(0);
    expect(seed.output).toMatch(/inactive root identity/i);
    expect(seed.output).toContain(canonicalEmail);
    expect(
      await prisma.user.findUnique({ where: { id: inactiveId } }),
    ).toMatchObject({ workEmail: canonicalEmail, isActive: false });
  });

  it('converges concurrent seeds after a users_workEmail_key insert race', async () => {
    // Break caught: letting the unique violation escape leaves one deployment
    // failed instead of re-reading and validating the winner's root row.
    const canonicalEmail = emailFor('concurrent-root');
    const [first, second] = await Promise.all([
      runSeed(`  ${canonicalEmail.toUpperCase()}  `),
      runSeed(`  ${canonicalEmail.toUpperCase()}  `),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);

    const rows = await prisma.user.findMany({
      where: { workEmail: { contains: runId } },
      select: { id: true, workEmail: true, isActive: true },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        workEmail: canonicalEmail,
        isActive: true,
      }),
    ]);
  });
});
