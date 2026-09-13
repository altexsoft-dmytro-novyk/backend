import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * PLAT-E4-S4.2d / test-design-epic-platform-4.md E4-C06 obligation (6) —
 * `s42d-ds-08` (see docs comment below for why not `-06`/`-07`).
 *
 * Scenario doc:
 *   docs/test-cases/access-control-kernel/dev-seed-spine/
 *     s42d-ds-08-dev-seed-absent-from-deploy-entrypoints.md
 *
 * Obligation (6) reads: the dev seed (`db:dev:seed-org` /
 * `scripts/dev-seed-org.ts`, Story 4.2d) is **absent from `prisma/seed.ts`
 * and `scripts/bootstrap-access-control.ts`** — the two real deploy-time
 * entrypoints (`npm run db:seed`, `npm run db:bootstrap:access-control`).
 * The plan's own oracle is `git grep -n "seed-org\|dev-seed-org"` over both
 * files; this spec automates that oracle plus one level of static-import
 * resolution, so a rerun does not depend on a human rerunning the grep.
 *
 * Static, DB-free, Nest-free — pure `node:fs` reads. Runs under `npm test`
 * (the unit project: `rootDir: "src"`, `testRegex: ".*\.spec.ts$"`), not
 * `npm run test:e2e` — the e2e project's `setupFilesAfterEnv` opens a real
 * Postgres connection for every `.e2e-spec.ts` file (see
 * `test/jest.setup-full-profile-grants-sentinel.ts`), which this obligation
 * does not need and must not pay for.
 *
 * SCENARIO ID: `s42d-ds-06` is already taken by
 * `test/user-management/access-control-adoption/s42d-ds-root-resolves-over-seeded-population.e2e-spec.ts`
 * ("root resolves reporting write over every seeded member..."), a
 * different E4-C06-adjacent scenario about root's own read access over the
 * seeded population, not this absence obligation. `s42d-ds-07` is reserved
 * on `feat/plat-e4-dev-seed-journal` (not yet merged) for the journaling
 * obligation (7) — `s42d-ds-07-seeded-edges-are-journaled.md`. The next
 * free id in the family is `s42d-ds-08`.
 *
 * WHY A PATH-RESOLUTION CHECK, NOT ONLY A TEXT GREP: `scripts/dev-seed-org.ts`
 * has no exports — it is a standalone script whose `main()` runs as an
 * import side effect. The only way it could end up wired into either
 * entrypoint is (a) a literal string mentioning the script/alias (the
 * plan's own grep), or (b) a bare `import '<relative path>'` of the file
 * itself, under any relative depth or a spelling the text grep would miss
 * (e.g. a resolved `.js` specifier). This spec checks both: a
 * case-insensitive text pattern AND resolving every relative import
 * specifier in each entrypoint (and one level into whatever *that* imports)
 * to an absolute path, comparing it against `dev-seed-org.ts`'s own
 * absolute path.
 */

const BACKEND_ROOT = resolve(__dirname, '../../../../');

const SEED_ENTRYPOINT = resolve(BACKEND_ROOT, 'prisma/seed.ts');
const BOOTSTRAP_ENTRYPOINT = resolve(
  BACKEND_ROOT,
  'scripts/bootstrap-access-control.ts',
);
const ENTRYPOINTS = [SEED_ENTRYPOINT, BOOTSTRAP_ENTRYPOINT];

const DEV_SEED_SCRIPT = resolve(BACKEND_ROOT, 'scripts/dev-seed-org.ts');
const DEV_SEED_NPM_ALIAS = 'db:dev:seed-org';

// The plan's own oracle, `git grep -n "seed-org\|dev-seed-org"`, expressed as
// one case-insensitive pattern — catches a comment, a string literal, or an
// identifier naming the dev seed.
const DEV_SEED_TEXT_PATTERN = /seed-org|dev-seed-org/i;

function readSource(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `PRECONDITION-REPAIR RED: expected entrypoint file is missing on disk: ${path}`,
    );
  }
  return readFileSync(path, 'utf8');
}

/** Every `import ... from '...'`, bare `import '...'`, and `require('...')` specifier. */
function extractImportSpecifiers(source: string): string[] {
  const pattern =
    /(?:^|\n)\s*(?:import|export)(?:[^'";]*?)\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Resolves a relative specifier to a real file on disk, trying `.ts` and `index.ts`. Non-relative (bare package) specifiers resolve to undefined — this obligation is about local files only. */
function resolveRelativeSpecifier(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    resolve(base, 'index.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function stripExt(path: string): string {
  return path.replace(/\.(ts|js)$/, '');
}

function isDevSeedModule(path: string): boolean {
  return stripExt(resolve(path)) === stripExt(DEV_SEED_SCRIPT);
}

/** One level of static-import resolution: the entrypoint's own relative imports, resolved to files on disk. Bare package specifiers (e.g. 'dotenv/config') are skipped — obligation (6) is about local wiring. */
function resolvedRelativeImports(entrypoint: string): string[] {
  const specifiers = extractImportSpecifiers(readSource(entrypoint));
  const resolved: string[] = [];
  for (const specifier of specifiers) {
    const path = resolveRelativeSpecifier(entrypoint, specifier);
    if (path) resolved.push(path);
  }
  return resolved;
}

describe('s42d-ds-08 · the dev seed is absent from prisma/seed.ts and scripts/bootstrap-access-control.ts', () => {
  it.each(ENTRYPOINTS)(
    's42d-ds-08 Test 1 · %s carries no textual reference to the dev seed script or its npm alias',
    (entrypoint) => {
      const source = readSource(entrypoint);
      expect(source).not.toMatch(DEV_SEED_TEXT_PATTERN);
      expect(source.includes(DEV_SEED_NPM_ALIAS)).toBe(false);
    },
  );

  it.each(ENTRYPOINTS)(
    's42d-ds-08 Test 2 · %s does not statically import scripts/dev-seed-org.ts, directly or one level deep',
    (entrypoint) => {
      const directImports = resolvedRelativeImports(entrypoint);
      expect(directImports.some(isDevSeedModule)).toBe(false);

      for (const oneLevelDeep of directImports) {
        expect(isDevSeedModule(oneLevelDeep)).toBe(false);
        const nested = resolvedRelativeImports(oneLevelDeep);
        expect(nested.some(isDevSeedModule)).toBe(false);
        expect(readSource(oneLevelDeep)).not.toMatch(DEV_SEED_TEXT_PATTERN);
      }
    },
  );

  it('s42d-ds-08 Test 3 · sanity: the resolver actually finds scripts/dev-seed-org.ts on disk (a false negative here would silently pass Tests 1-2 for the wrong reason)', () => {
    expect(existsSync(DEV_SEED_SCRIPT)).toBe(true);
    expect(readSource(DEV_SEED_SCRIPT)).toMatch(DEV_SEED_TEXT_PATTERN);
  });
});
