import { createHmac } from 'crypto';

// AD-21: the session/access token is a stateless signed JWT carrying
// `userId`, `issuedAt`, expiry — issued only after magic-link consumption,
// no server-side session table. Epic 2 (magic-link) has not been built yet,
// so this is a lightweight deterministic signer standing in for that real
// issuance flow, producing tokens shaped exactly the way the eventual
// facade guard will need to verify them (same claim names, same HS256
// shape). Swap this file's secret source for the real one once Epic 2
// lands — nothing about the E2E call sites should need to change.
const SESSION_JWT_SECRET =
  process.env.ACCESS_CONTROL_TEST_JWT_SECRET ??
  'access-control-e2e-fixture-secret-not-for-production';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface SessionTokenClaims {
  userId: string;
  issuedAt: number;
  exp: number;
}

function sign(payload: SessionTokenClaims): string {
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

/** A valid, currently-live session token for the given fixture user id. */
export function signSessionToken(
  userId: string,
  opts: { issuedAtSeconds?: number; expiresInSeconds?: number } = {},
): string {
  const issuedAt = opts.issuedAtSeconds ?? Math.floor(Date.now() / 1000) - 5;
  const expiresInSeconds = opts.expiresInSeconds ?? 60 * 60;
  return sign({ userId, issuedAt, exp: issuedAt + expiresInSeconds });
}

/** An already-expired session token, for 401 negative scenarios. */
export function signExpiredSessionToken(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000) - 7200;
  return sign({ userId, issuedAt, exp: issuedAt - 3600 });
}

/** Syntactically well-formed but unsigned/garbage bearer value. */
export function malformedToken(): string {
  return 'not-a-real-session-token';
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
