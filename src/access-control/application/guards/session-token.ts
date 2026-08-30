import { createHmac, timingSafeEqual } from 'crypto';

// AD-21: verifies the stateless signed session/access token — same claim
// names, same HS256 shape as test/access-control/fixtures/jwt.ts's
// deterministic fixture signer. Swap the secret source for the real Epic 2
// issuance flow later; nothing about this verification shape should need
// to change.
const SESSION_JWT_SECRET =
  process.env.ACCESS_CONTROL_TEST_JWT_SECRET ??
  'access-control-e2e-fixture-secret-not-for-production';

export interface SessionTokenClaims {
  userId: string;
  issuedAt: number;
  exp: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * AD-21: issues the stateless signed session/access token, only ever called
 * after a successful magic-link consumption (Epic 2). Same claim names, same
 * HS256 shape, same secret source as verifySessionToken below and as
 * test/access-control/fixtures/jwt.ts's deterministic fixture signer — one
 * authority for the token shape, not a second parallel scheme.
 */
export function signSessionToken(
  userId: string,
  opts: { issuedAtSeconds?: number; expiresInSeconds?: number } = {},
): string {
  const issuedAt = opts.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = opts.expiresInSeconds ?? 60 * 60;
  const payload: SessionTokenClaims = {
    userId,
    issuedAt,
    exp: issuedAt + expiresInSeconds,
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = base64url(
    createHmac('sha256', SESSION_JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest(),
  );
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/** Returns verified claims, or null for any malformed/unsigned/expired token. */
export function verifySessionToken(token: string): SessionTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const expectedSignature = base64url(
    createHmac('sha256', SESSION_JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest(),
  );

  const actual = Buffer.from(encodedSignature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  let claims: SessionTokenClaims;
  try {
    claims = JSON.parse(
      base64urlDecode(encodedPayload).toString('utf8'),
    ) as SessionTokenClaims;
  } catch {
    return null;
  }

  if (typeof claims.userId !== 'string' || !UUID_RE.test(claims.userId)) {
    return null;
  }
  if (
    typeof claims.exp !== 'number' ||
    claims.exp < Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return claims;
}
