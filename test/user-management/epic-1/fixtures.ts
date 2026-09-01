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
