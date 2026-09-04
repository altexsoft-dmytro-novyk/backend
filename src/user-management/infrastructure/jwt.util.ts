import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT sign/verify for the `/auth` session token (Epic 2 Story
 * 2.2). `node:crypto` is the Node standard library — the same accepted pattern
 * `MagicLinkService` already uses for token hashing — so this area does not take
 * on an external JWT dependency for a two-claim token.
 *
 * Supported: compact JWS, `{"alg":"HS256","typ":"JWT"}` header, a JSON payload
 * with a numeric `exp` (seconds since the epoch). Anything else — a different
 * `alg`, a malformed segment, a bad signature, a past `exp` — verifies to
 * `null`.
 */

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface SessionJwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

/** Sign `{ sub, iat, exp }` as a compact HS256 JWT. */
export function signSessionJwt(
  payload: SessionJwtPayload,
  secret: string,
): string {
  const signingInput = `${b64url(JSON.stringify(HEADER))}.${b64url(
    JSON.stringify(payload),
  )}`;
  const signature = createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Verify signature + `exp` and return the payload, or `null` on any failure
 * (wrong shape, wrong `alg`, bad signature, expired, unparseable).
 */
export function verifySessionJwt(
  token: string,
  secret: string,
): SessionJwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const expected = createHmac('sha256', secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureSegment, 'base64url');
  } catch {
    return null;
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString());
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString());
  } catch {
    return null;
  }

  if (
    typeof header !== 'object' ||
    header === null ||
    (header as Record<string, unknown>).alg !== 'HS256'
  ) {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const claims = payload as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') {
    return null;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= claims.exp) {
    return null;
  }

  return {
    sub: claims.sub,
    iat: typeof claims.iat === 'number' ? claims.iat : nowSeconds,
    exp: claims.exp,
  };
}
