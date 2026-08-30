import { createHash, randomBytes } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../../../src/prisma/prisma.service';

/**
 * AD-21: magic-link tokens are opaque random values, hashed at rest
 * (MagicLinkToken.tokenHash). No stage-3 implementation exists yet to fix
 * the exact hash function, so this fixture picks the contract Epic 2 must
 * land on — plain SHA-256 hex of the raw opaque token, no per-token salt (a
 * per-token random value already makes rainbow-table precomputation
 * impractical; DEC-UM-004 requires the value be "hashed at rest", not
 * salted-per-user). If stage-3 lands a different scheme, only this
 * function's body needs to change — every call site in this suite goes
 * through it.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function newRawToken(): string {
  return randomBytes(32).toString('hex');
}

export interface MintedToken {
  raw: string;
  id: string;
}

/** A valid, unexpired, undispatched-status-aside magic-link token for userId. */
export async function mintMagicLinkToken(
  prisma: PrismaService,
  userId: string,
  opts: { expiresInMs?: number; consumedAt?: Date | null } = {},
): Promise<MintedToken> {
  const raw = newRawToken();
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 15 * 60 * 1000));
  const row = await prisma.magicLinkToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt,
      consumedAt: opts.consumedAt ?? null,
      dispatchStatus: 'sent',
    },
  });
  return { raw, id: row.id };
}

/** An already-expired magic-link token, for the um-auth-04 negative case. */
export async function mintExpiredMagicLinkToken(
  prisma: PrismaService,
  userId: string,
): Promise<MintedToken> {
  const raw = newRawToken();
  const row = await prisma.magicLinkToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() - 60 * 1000),
      dispatchStatus: 'sent',
    },
  });
  return { raw, id: row.id };
}

/**
 * Mints a real, valid magic-link token directly via Prisma (no
 * HTTP-observable dispatch seam exists to request one through — that's
 * exactly what this task builds), then consumes it through the real
 * POST /auth/magic-link/consume endpoint — so the seed suite's session
 * bootstrap and the auth suite's own consume-success case share one real
 * mechanism, per this task's brief ("don't invent a second, parallel
 * fake-auth path"). Throws with a diagnostic message if consume doesn't
 * yet return a usable session — expected until Epic 2 lands (stage 3).
 */
export async function establishSession(
  app: INestApplication<App>,
  prisma: PrismaService,
  userId: string,
): Promise<string> {
  const { raw } = await mintMagicLinkToken(prisma, userId);
  const res = await request(app.getHttpServer())
    .post('/auth/magic-link/consume')
    .set('authorization', '')
    .send({ token: raw });

  const body = res.body as Record<string, unknown>;
  const sessionToken = (body.accessToken ?? body.sessionToken ?? body.token) as
    string | undefined;

  if (res.status !== 200 || !sessionToken) {
    throw new Error(
      `establishSession: POST /auth/magic-link/consume did not return a usable ` +
        `session (status ${res.status}, body ${JSON.stringify(body)}) — expected ` +
        `until Epic 2's consume endpoint is implemented (stage 3).`,
    );
  }
  return sessionToken;
}
