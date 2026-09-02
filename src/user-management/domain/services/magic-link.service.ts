import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUTH_USER_LOOKUP_PORT,
  type AuthUserLookupPort,
} from '../interfaces/auth-user-lookup.port';
import {
  MAGIC_LINK_DISPATCHER_PORT,
  type MagicLinkDispatcherPort,
} from '../interfaces/magic-link-dispatcher.port';
import {
  MAGIC_LINK_TOKEN_REPOSITORY_PORT,
  type MagicLinkTokenRepositoryPort,
} from '../interfaces/magic-link-token.repository.port';
import { MAGIC_LINK_TTL_MINUTES } from '../interfaces/magic-link-ttl.token';
import {
  SESSION_TOKEN_ISSUER_PORT,
  type SessionTokenIssuerPort,
} from '../interfaces/session-token-issuer.port';

/**
 * The success payload of `POST /auth/magic-link/consume` (auth/README decision
 * 9). `consume` returns this on a full success and `null` on every failure —
 * not-found / expired / already-consumed / owner-inactive are one generic
 * denial (DEC-UM-004), mapped to a bare `401` by the action.
 */
export interface EstablishedSession {
  sessionToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/**
 * Epic 2 Story 2.1 — the `/auth` sub-area domain service (AD-2: the only holder
 * of this flow's ports). Owns the enumeration-safe magic-link request: it never
 * signals whether an account exists.
 *
 * `node:crypto` is the Node standard library, not an external integration or an
 * SDK — the class still imports no Prisma, no HTTP/transport types, and no
 * adapter by name.
 */
@Injectable()
export class MagicLinkService {
  constructor(
    @Inject(AUTH_USER_LOOKUP_PORT)
    private readonly users: AuthUserLookupPort,
    @Inject(MAGIC_LINK_TOKEN_REPOSITORY_PORT)
    private readonly tokens: MagicLinkTokenRepositoryPort,
    @Inject(MAGIC_LINK_DISPATCHER_PORT)
    private readonly dispatcher: MagicLinkDispatcherPort,
    @Inject(MAGIC_LINK_TTL_MINUTES)
    private readonly ttlMinutes: number,
    @Inject(SESSION_TOKEN_ISSUER_PORT)
    private readonly sessionTokens: SessionTokenIssuerPort,
  ) {}

  /**
   * Normalize the address (DEC-UM-007), look up an active user, and — only on a
   * match — mint one token and dispatch one link. No match (unknown or
   * deactivated) is a silent no-op. Always resolves; the caller returns the same
   * generic body either way.
   */
  async requestLink(rawEmail: string): Promise<void> {
    const workEmail = rawEmail.trim().toLowerCase();
    const user = await this.users.findActiveByWorkEmail(workEmail);
    if (!user) {
      return;
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);

    await this.tokens.mint({ userId: user.id, tokenHash, expiresAt });

    // NFR-3: a delivery failure must not crash the request or leak an
    // account-existence signal. The real adapter swallows transport errors
    // internally (logs + resolves), so a normal `await` is enough here — the
    // token is already persisted and the user can request another link.
    await this.dispatcher.dispatch(user.workEmail, rawToken);
  }

  /**
   * Consume a raw magic-link token and establish a session (Story 2.2 —
   * `um-auth-03..06`). Returns the session payload on a full success, or `null`
   * for every denial (DEC-UM-004: one generic failure, no signal which):
   *   - no `magic_link_token` row hashes to this raw token;
   *   - the row is already consumed (`consumedAt != null`);
   *   - the row has expired (`expiresAt <= now`) — NOT marked consumed;
   *   - the owner is no longer active (deactivated / departed after mint);
   *   - a concurrent request won the atomic single-use race.
   * On success the row's `consumedAt` is set atomically (conditional UPDATE) and
   * a session token is minted via the issuer port.
   */
  async consume(rawToken: string): Promise<EstablishedSession | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const record = await this.tokens.findByHash(tokenHash);
    if (!record || record.consumedAt) {
      return null;
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      // Expiry is not consumption — leave `consumedAt` null (um-auth-04).
      return null;
    }

    const owner = await this.users.findActiveById(record.userId);
    if (!owner) {
      return null;
    }

    const consumed = await this.tokens.markConsumed(record.id);
    if (!consumed) {
      return null;
    }

    const issued = this.sessionTokens.issue(owner.id);
    return {
      sessionToken: issued.token,
      tokenType: 'Bearer',
      expiresIn: issued.expiresInSeconds,
    };
  }
}
