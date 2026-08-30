import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '../../generated/prisma/client';

// AD-21: magic-link tokens are opaque random values, hashed at rest
// (MagicLinkToken.tokenHash), single-use, DB-backed. Pragmatic infrastructure
// repository consumed directly by AuthController, matching the established
// deviation already documented in ProfileDataRepository (full hexagon
// port/adapter layering is access-control's own deliverable; this file
// follows the same pragmatic, documented pattern).
//
// Hashing scheme: plain SHA-256 hex of the raw opaque token, no per-token
// salt — matching test/user-management/fixtures/magic-link.ts's `hashToken`
// exactly (that fixture picked this contract before this file existed; kept
// here rather than diverging). This is a deliberate, not a default, choice:
// unlike password hashing, a magic-link token already carries 256 bits of
// its own entropy (randomBytes(32)), so a fast hash is fine here — a
// rainbow-table/brute-force attack against SHA-256(token) is exactly as
// infeasible as guessing the token itself. Slow hashing (bcrypt/argon2)
// exists to defend low-entropy secrets (passwords); it buys nothing here and
// would only slow down every consume request.
const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface MintedMagicLinkToken {
  raw: string;
  id: string;
  userId: string;
}

export interface ConsumedMagicLinkToken {
  userId: string;
}

export function hashMagicLinkToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class MagicLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveUserByEmail(normalizedEmail: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { workEmail: normalizedEmail },
    });
  }

  findActiveUserById(userId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id: userId } });
  }

  async mint(userId: string): Promise<MintedMagicLinkToken> {
    const raw = randomBytes(32).toString('hex');
    const row = await this.prisma.magicLinkToken.create({
      data: {
        userId,
        tokenHash: hashMagicLinkToken(raw),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        dispatchStatus: 'sent',
      },
    });
    return { raw, id: row.id, userId };
  }

  /**
   * Atomically consumes a valid, unexpired, not-yet-consumed token
   * (AD-21 single-use) — the `consumedAt: null` guard in the WHERE clause,
   * combined with Postgres's row-level atomicity for a single UPDATE, is
   * what prevents two concurrent requests from both succeeding against the
   * same raw token (um-auth-05 replay prevention).
   */
  async tryConsume(rawToken: string): Promise<ConsumedMagicLinkToken | null> {
    const tokenHash = hashMagicLinkToken(rawToken);
    const token = await this.prisma.magicLinkToken.findUnique({
      where: { tokenHash },
    });
    if (!token) return null;
    if (token.expiresAt.getTime() < Date.now()) return null;
    if (token.consumedAt !== null) return null;

    const result = await this.prisma.magicLinkToken.updateMany({
      where: { id: token.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (result.count !== 1) return null;

    return { userId: token.userId };
  }
}
