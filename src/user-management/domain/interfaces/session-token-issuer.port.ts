// Outbound port for minting a session token once a magic-link token is
// successfully consumed (Epic 2 Story 2.2). The adapter
// (`infrastructure/jwt-session-token-issuer.adapter.ts`) signs a stateless
// HS256 JWT — no `Session` table, no per-request DB read (auth/README decision
// 10). The domain service holds only this port; it never sees the JWT secret,
// the TTL config, or `node:crypto` signing details.

export interface IssuedSessionToken {
  /** The bearer credential the client sends back as `Authorization: Bearer …`. */
  token: string;
  /** Session lifetime in seconds — the `expiresIn` field of the 200 body. */
  expiresInSeconds: number;
}

export interface SessionTokenIssuerPort {
  issue(userId: string): IssuedSessionToken;
}

export const SESSION_TOKEN_ISSUER_PORT = Symbol('SESSION_TOKEN_ISSUER_PORT');
