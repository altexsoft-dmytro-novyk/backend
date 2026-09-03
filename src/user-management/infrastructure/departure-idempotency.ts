import { createHash } from 'node:crypto';

// database-schema.md §Departure types `idempotencyKey` as `uuid, unique`. The
// `Idempotency-Key` header is caller-chosen and is not required to be a UUID, so
// this coerces it deterministically to the column type: a well-formed UUID is
// used as-is (lower-cased); anything else is hashed to a stable v-flagged UUID
// string (same header value -> same coerced key, so replay lookups and the
// partial UNIQUE still hold). Persistence-shaping — lives in `infrastructure/`.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function coerceIdempotencyKeyToUuid(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const hex = createHash('sha256').update(trimmed).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
