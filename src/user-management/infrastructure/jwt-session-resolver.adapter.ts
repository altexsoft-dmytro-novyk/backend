import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  Session,
  SessionResolverPort,
} from '../domain/interfaces/session-resolver.port';
import { DepartureMetricsService } from './departure-metrics.service';
import { verifySessionJwt } from './jwt.util';

const BEARER_PREFIX = /^Bearer /;
const BEARER_PERSONA_TOKEN = /^Bearer <token:(?<persona>[^>]+)>$/;
const INTERIM_ROOT_EMAIL_PREFIX = 'interim-root-';

/**
 * Epic 2 Story 2.2 — the real `SessionResolverPort` (AD-21 cutover). This is the
 * single session resolver: `interim-session-resolver.adapter.ts` is deleted and
 * this adapter is bound in its place (auth/README decision 12 — "one adapter, no
 * dual-running").
 *
 * Resolution order:
 *
 *  1. **Real session token** — an `Authorization: Bearer <jwt>` minted by
 *     `POST /auth/magic-link/consume`. Verified (signature + `exp`) with
 *     `SESSION_JWT_SECRET`; resolves to `{ userId: sub }`. This is the only path
 *     enabled in production.
 *
 *  2. **`Bearer <token:<persona>>` dev shorthand** — folded in from the retired
 *     interim adapter, but ONLY when `ALLOW_TEST_SESSION_TOKENS` is set (Joi
 *     default: `true` unless `NODE_ENV === 'production'`). The ~15 existing e2e
 *     suites and the Epic 0 fixtures authenticate this way (`Bearer
 *     <token:<seeded-uuid>>`, plus the `Root` persona → the seeded HR-Admin).
 *     Refused outright in production, so AD-21's "the interim capability moves
 *     into the real adapter, it is not kept alongside it" holds.
 *
 * Any failure on both paths → `null` (the guard turns that into a generic 401).
 */
@Injectable()
export class JwtSessionResolverAdapter implements SessionResolverPort {
  private readonly jwtSecret: string;
  private readonly allowTestSessionTokens: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly departureMetrics: DepartureMetricsService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('SESSION_JWT_SECRET');
    this.allowTestSessionTokens = config.getOrThrow<boolean>(
      'ALLOW_TEST_SESSION_TOKENS',
    );
  }

  async resolve(
    authorizationHeader: string | undefined,
  ): Promise<Session | null> {
    if (!authorizationHeader) {
      return null;
    }

    let session: Session | null = null;
    if (this.allowTestSessionTokens) {
      session = await this.resolveTestShorthand(authorizationHeader);
    }
    if (!session) {
      const raw = authorizationHeader.replace(BEARER_PREFIX, '');
      const payload = verifySessionJwt(raw, this.jwtSecret);
      session = payload ? { userId: payload.sub } : null;
    }

    return this.applyEffectiveDepartureCutoff(session);
  }

  /**
   * Epic 5 Story 5.2 (AD-20) — the request-time cutoff. From `00:00` on the
   * effective date in `effectiveTimeZone` (the stored `dueAt`), the resolved
   * person's session does NOT resolve — the guard returns the same `401` as an
   * unresolved session, BEFORE any feature or audience resolution. Independent
   * of the worker: worker lag delays materialised cleanup but can never leave a
   * usable session for a due person. One query per request, not cached. The
   * comparison is PostgreSQL `now()`, never JS `Date`.
   */
  private async applyEffectiveDepartureCutoff(
    session: Session | null,
  ): Promise<Session | null> {
    if (!session) {
      return null;
    }
    const rows = await this.prisma.$queryRawUnsafe<Array<{ hit: number }>>(
      `SELECT 1 AS hit FROM "departures"
        WHERE "userId" = $1
          AND "dueAt" <= now()
          AND state IN ('scheduled', 'processing', 'retry_wait', 'applied')
        LIMIT 1`,
      session.userId,
    );
    if (rows.length > 0) {
      this.departureMetrics.recordRequestTimeCutoffDenial();
      return null;
    }
    return session;
  }

  /**
   * The `Bearer <token:<persona>>` fixture convention (docs/test-cases/README.md).
   * `<persona>` is normally a seeded `User` uuid, resolved as-is; the literal
   * `Root` persona resolves to whichever seeded row holds `position: 'HR Admin'`,
   * lazily self-provisioning a stand-in when a suite has no bootstrap of its own
   * (verbatim from the retired `InterimSessionResolverAdapter`). Any other
   * non-uuid persona falls through to the access-control deny-by-default.
   */
  private async resolveTestShorthand(
    authorizationHeader: string,
  ): Promise<Session | null> {
    const persona =
      BEARER_PERSONA_TOKEN.exec(authorizationHeader)?.groups?.persona;
    if (!persona) {
      return null;
    }
    if (persona === 'Root') {
      const hrAdmin = await this.resolveOrProvisionRoot();
      return { userId: hrAdmin.id };
    }
    return { userId: persona };
  }

  private async resolveOrProvisionRoot(): Promise<{ id: string }> {
    const realHrAdmin = await this.prisma.user.findFirst({
      where: {
        position: 'HR Admin',
        workEmail: { not: { startsWith: INTERIM_ROOT_EMAIL_PREFIX } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (realHrAdmin) {
      return realHrAdmin;
    }

    const anyInterimRoot = await this.prisma.user.findFirst({
      where: { workEmail: { startsWith: INTERIM_ROOT_EMAIL_PREFIX } },
      orderBy: { createdAt: 'desc' },
    });
    if (anyInterimRoot) {
      return anyInterimRoot;
    }

    const id = uuidv7();
    return this.prisma.user.create({
      data: {
        id,
        firstName: 'Root',
        lastName: 'Admin',
        position: 'HR Admin',
        country: '',
        city: '',
        workEmail: `${INTERIM_ROOT_EMAIL_PREFIX}${id}@company.example`,
        companyJoinDate: new Date('1970-01-01'),
        createdBy: id,
      },
    });
  }
}
