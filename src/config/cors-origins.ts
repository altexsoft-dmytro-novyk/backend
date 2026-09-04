// `CORS_ORIGIN` is a comma-separated list of allowed origins. The `cors` package
// compares the request's `Origin` header verbatim against each entry, so an
// entry must be a BARE origin — `scheme://host[:port]`, no path / query /
// fragment and no trailing slash — or it can never match. Parsed here for both
// `env.validation.ts` (boot-time check) and `main.ts` (the value handed to
// `app.enableCors`).
const BARE_ORIGIN = /^https?:\/\/[^/?#\s]+$/;

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** The trimmed, non-empty entries of a `CORS_ORIGIN` value. */
export function parseCorsOrigins(value: string): string[] {
  return splitList(value);
}

/**
 * `null` when every entry is a bare origin and the list is non-empty; an
 * explanatory message otherwise. Backs the Joi env schema check.
 */
export function checkCorsOriginsCsv(value: string): string | null {
  const origins = splitList(value);
  if (origins.length === 0) {
    return 'must list at least one origin';
  }
  const malformed = origins.filter((origin) => !BARE_ORIGIN.test(origin));
  return malformed.length > 0
    ? `not bare origins (scheme://host[:port], no path): ${malformed.join(', ')}`
    : null;
}
