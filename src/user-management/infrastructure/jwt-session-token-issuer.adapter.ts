import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  IssuedSessionToken,
  SessionTokenIssuerPort,
} from '../domain/interfaces/session-token-issuer.port';
import { signSessionJwt } from './jwt.util';

/**
 * Epic 2 Story 2.2 — the real session-token issuer. Signs a stateless HS256 JWT
 * (`sub = userId`, `iat`, `exp = iat + SESSION_TTL_HOURS`) with
 * `SESSION_JWT_SECRET`. Stateless by design (auth/README decision 10): Story 2.2
 * has no logout / refresh / server-side revocation requirement, so there is no
 * `Session` model and no migration.
 */
@Injectable()
export class JwtSessionTokenIssuerAdapter implements SessionTokenIssuerPort {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('SESSION_JWT_SECRET');
    this.ttlSeconds = config.getOrThrow<number>('SESSION_TTL_HOURS') * 3600;
  }

  issue(userId: string): IssuedSessionToken {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.ttlSeconds;
    return {
      token: signSessionJwt({ sub: userId, iat, exp }, this.secret),
      expiresInSeconds: this.ttlSeconds,
    };
  }
}
