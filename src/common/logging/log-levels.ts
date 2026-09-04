import type { LogLevel } from '@nestjs/common';

// The Nest console logger takes an explicit list of enabled levels (it is not a
// single threshold). `LOG_LEVELS` is a comma-separated subset of these. Both
// `env.validation.ts` (boot-time validation) and `main.ts` (via `parseLogLevels`,
// fed to `app.useLogger()`) go through the helpers here, so the accepted set and
// the fallback can never drift apart.
const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

// Single source of truth for "no LOG_LEVELS configured" — used both as the Joi
// `.default(...)` and as the `parseLogLevels` fallback.
export const DEFAULT_LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'log',
  'warn',
  'error',
];
export const DEFAULT_LOG_LEVELS_CSV = DEFAULT_LOG_LEVELS.join(',');

const isLogLevel = (value: string): value is LogLevel =>
  (VALID_LOG_LEVELS as readonly string[]).includes(value);

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * `null` when `value` is a non-empty comma-separated list of known Nest log
 * levels; an explanatory message otherwise. Backs the Joi env schema check.
 */
export function checkLogLevelsCsv(value: string): string | null {
  const levels = splitList(value);
  if (levels.length === 0) {
    return 'must list at least one log level';
  }
  const unknown = levels.filter((level) => !isLogLevel(level));
  return unknown.length > 0
    ? `unknown log level(s): ${unknown.join(', ')}`
    : null;
}

/**
 * Parse `LOG_LEVELS` into the list `app.useLogger()` wants. Unknown entries are
 * dropped and an empty result falls back to `DEFAULT_LOG_LEVELS`; the env schema
 * already rejects a malformed value at boot, so on the app path this only ever
 * returns the configured list.
 */
export function parseLogLevels(value: string | undefined): LogLevel[] {
  const levels = splitList(value ?? '').filter(isLogLevel);
  return levels.length > 0 ? levels : [...DEFAULT_LOG_LEVELS];
}
