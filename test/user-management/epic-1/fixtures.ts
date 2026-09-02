import 'dotenv/config';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/generated/prisma/client';

// Shared helpers for the Epic 1 — Employee Record Management Stage-2 E2E
// suites (seed / profile-v15 / list-v15), v1.5.
//
// The app-booting parts (`bootstrapTestApp`, `RunFixtures`, `bearer`) are the
// Epic 0 adoption fixtures, reused verbatim — they already give AD-3-clean boot
// (real `AppModule`, real Prisma / migrated PostgreSQL, no provider overrides),
// real `User` + `Relationship` inserts, run-namespaced emails and wrapped,
// scoped teardown (DEC-UM-010). This file adds only what Epic 1 needs on top:
// a child-process runner for the deploy-order scripts (`db:seed`,
// `db:bootstrap:access-control`, and the not-yet-existing population importer),
// a bare `PrismaClient` for the `um-seed-*` database-state assertions (which
// have no HTTP surface — the importer is a writer, not a request handler), and
// a tiny semicolon-CSV reader for `docs/Accounts_template.csv`.
export {
  bootstrapTestApp,
  bearer,
  RunFixtures,
  type TestApp,
  type UserOverrides,
} from '../access-control-adoption/fixtures';

const execFileAsync = promisify(execFile);

/** `services/backend` — cwd for `npm run <script>`. */
export const BACKEND_ROOT = path.resolve(__dirname, '../../..');

/** The delivered semicolon-delimited timetracker export (repo root `docs/`). */
export const POPULATION_CSV_PATH = path.resolve(
  __dirname,
  '../../../../../docs/Accounts_template.csv',
);

/**
 * ASSUMED production entrypoint for Story 1.1's population import.
 *
 * The spec (`spec-1-1-import-seeded-population.md` "Open Questions / Gates")
 * leaves "whether the import runs as a script, an authorized operator HTTP
 * command, or both" an explicit architect call, and names no command. This
 * suite invokes `npm run <IMPORT_SCRIPT>` as the closest sibling of the other
 * deploy-order scripts (`db:seed`, `db:bootstrap:access-control`). Until that
 * script exists the invocation exits non-zero and every `um-seed-01/03`
 * assertion downstream of it is **committed red on the missing importer**.
 * When the real entrypoint lands under a different name, change this constant.
 */
export const IMPORT_SCRIPT = 'db:import:population';

export interface ScriptRun {
  exitCode: number;
  output: string;
}

/** Run `npm run <script>` against the real backend, capturing exit + output. */
export async function runScript(
  script: string,
  env: Record<string, string> = {},
  scriptArgs: string[] = [],
): Promise<ScriptRun> {
  const args = [
    'run',
    script,
    ...(scriptArgs.length ? ['--', ...scriptArgs] : []),
  ];
  try {
    const { stdout, stderr } = await execFileAsync('npm', args, {
      cwd: BACKEND_ROOT,
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error: unknown) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
    };
  }
}

/** Bare Prisma client for the no-HTTP `um-seed-*` database-state assertions. */
export function rawPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
}

export interface CsvRow {
  [column: string]: string;
}

/**
 * Minimal reader for the delivered export: strips a UTF-8 BOM, splits on `;`,
 * keeps the literal token `NULL` as-is (the caller maps it). No quoting rules —
 * the TT export has none.
 */
export function readSemicolonCsv(filePath: string): {
  header: string[];
  rows: CsvRow[];
} {
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0].split(';');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row: CsvRow = {};
    header.forEach((column, i) => {
      row[column] = cells[i] ?? '';
    });
    return row;
  });
  return { header, rows };
}

export const isCsvNull = (value: string): boolean =>
  value === '' || value.toUpperCase() === 'NULL';

export const normalizeEmail = (value: string): string =>
  value.trim().toLowerCase();

/** Write a throwaway semicolon-CSV (same header as the delivered export). */
export function writeTempPopulationCsv(dataRows: CsvRow[]): string {
  const { header } = readSemicolonCsv(POPULATION_CSV_PATH);
  const lines = [
    header.join(';'),
    ...dataRows.map((row) => header.map((c) => row[c] ?? 'NULL').join(';')),
  ];
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'um-seed-')),
    'population.csv',
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

// ───────────────────────────────────────────────────────────────────────────
// Story 1.5 (List Employees) Stage-2 helper — seed a current EmploymentStatus
// ───────────────────────────────────────────────────────────────────────────

/**
 * Give `userId` a current (`validTo IS NULL`) `EmploymentStatus` of `status`,
 * closing any existing current row first (the partial unique index
 * `employment_status_one_current_per_user` permits only one current row per
 * user). Story 1.1 shipped the aggregate; the Epic 5 departure workflow that
 * sets `dismissed` in production is CC-06-blocked and exposes no HTTP surface,
 * so `um-list-05` / `um-list-06` seed the fact directly against the test DB
 * (README "Decisions made in-scenario" §6; testing-strategy.md AD-3 — "stage-2
 * seeds the EmploymentStatus: dismissed fact directly").
 *
 * Cascades away with the user row on teardown (`employment_status.userId` FK is
 * `ON DELETE CASCADE`), so `RunFixtures.cleanup` needs no extra step.
 */
export async function seedCurrentEmploymentStatus(
  prisma: PrismaClient,
  userId: string,
  status: 'active' | 'dismissed',
  opts: { validFrom?: string; closeExistingAt?: string } = {},
): Promise<void> {
  const validFrom = new Date(opts.validFrom ?? '2020-01-01');
  const closeAt = new Date(
    opts.closeExistingAt ?? opts.validFrom ?? '2020-01-01',
  );
  await prisma.$executeRawUnsafe(
    `UPDATE employment_status SET "validTo" = $1 WHERE "userId" = $2 AND "validTo" IS NULL`,
    closeAt,
    userId,
  );
  await prisma.employmentStatus.create({ data: { userId, status, validFrom } });
}

/** `true` iff a relation exists — lets a test assert "table missing" crisply. */
export async function relationExists(
  prisma: PrismaClient,
  table: string,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    table,
  );
  return rows[0]?.exists === true;
}

// ───────────────────────────────────────────────────────────────────────────
// Story 1.1 `POST /users/import` real-consumer HTTP E2E helpers (AD-1 Stage 2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The delivered semicolon-CSV header, verbatim
 * (`docs/Accounts_template.csv` — [seed README] "Column → User field mapping").
 * Kept as a literal so the fixture builder does not have to read the repo file;
 * the fixtures are small purpose-built pseudonymised CSV strings (NFR-1).
 */
export const DELIVERED_CSV_COLUMNS = [
  'FirstName',
  'LastName',
  'Email',
  'Birthday',
  'PositionId',
  'PositionName',
  'RegistrationDate',
  'DepartmentId',
  'DepartmentName',
  'DismissedDate',
  'IsDismissed',
  'EmployeeType',
  'TimeZone',
  'CountryId',
  'CountryCode',
  'CountryName',
  'CountryStateId',
  'CountryStateName',
] as const;

export type SeedCsvColumn = (typeof DELIVERED_CSV_COLUMNS)[number];
export type SeedCsvRow = Partial<Record<SeedCsvColumn, string>>;

export const DELIVERED_CSV_HEADER = DELIVERED_CSV_COLUMNS.join(';');

/**
 * Build an in-memory semicolon-delimited CSV with the delivered header verbatim.
 * A column omitted from a row object is emitted as the literal token `NULL`
 * (the import maps `NULL`/empty per DEC — `isCsvNull`); pass `''` explicitly to
 * emit a genuinely empty cell (the `um-seed-09` "missing required field" case).
 */
export function toDeliveredCsv(rows: SeedCsvRow[]): string {
  const lines = [
    DELIVERED_CSV_HEADER,
    ...rows.map((row) =>
      DELIVERED_CSV_COLUMNS.map((column) =>
        row[column] === undefined ? 'NULL' : row[column],
      ).join(';'),
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Expected synchronous summary body of a structurally valid import
 * ([seed README] "Row-level problems → 200 OK").
 */
export interface ImportSummary {
  created: number;
  updated: number;
  departmentsCreated: number;
  skipped: number;
  errors: Array<{ line: number; email: string | null; reason: string }>;
}

/**
 * Delete everything an import run under `marker` (a run-scoped email infix)
 * could have written, in FK-safe order. Guarded by `relationExists` so it is a
 * no-op while the Story 1.1 schema (`department` / `department_membership` /
 * `employment_status` / `user_events`) does not exist yet. Every step wrapped —
 * one failure never skips the rest (DEC-UM-010).
 */
export async function cleanupImportedRows(
  prisma: PrismaClient,
  marker: string,
): Promise<void> {
  const like = `%${marker}%`;
  const steps: Array<() => Promise<unknown>> = [
    async () => {
      if (await relationExists(prisma, 'user_events')) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM user_events WHERE "userId" IN (SELECT id FROM users WHERE "workEmail" ILIKE $1)`,
          like,
        );
      }
    },
    async () => {
      if (await relationExists(prisma, 'department_membership')) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM department_membership WHERE "userId" IN (SELECT id FROM users WHERE "workEmail" ILIKE $1)`,
          like,
        );
      }
    },
    async () => {
      if (await relationExists(prisma, 'employment_status')) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM employment_status WHERE "userId" IN (SELECT id FROM users WHERE "workEmail" ILIKE $1)`,
          like,
        );
      }
    },
    async () => {
      if (await relationExists(prisma, 'department')) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM department WHERE name ILIKE $1 OR "externalId" ILIKE $1`,
          like,
        );
      }
    },
    () =>
      prisma.user.deleteMany({ where: { workEmail: { contains: marker } } }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.warn('[um-seed] imported-row cleanup step failed', error);
    }
  }
}
