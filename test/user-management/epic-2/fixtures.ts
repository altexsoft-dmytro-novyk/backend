import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  MAGIC_LINK_DISPATCHER_PORT,
  type MagicLinkDispatcherPort,
} from '../../../src/user-management/domain/interfaces/magic-link-dispatcher.port';

// Shared fixtures for the Epic 2 — Magic-Link Authentication Stage-2 E2E suites
// (um-auth-01..06), v1.5. AD-1 Stage-2, committed red.
//
// AD-3 consumer rule: the suites boot the real `AppModule` (real
// UserManagementModule, real @Global AccessControlModule), real Prisma against
// migrated PostgreSQL, and NO `overrideProvider` on the database, repositories,
// router, session resolver, or the AccessControl facade.
//
// THE ONE ALLOWED OVERRIDE (HARD RULE 2 / AD-15): the outbound magic-link email
// dispatcher (`MAGIC_LINK_DISPATCHER_PORT`). The production binding
// (`MagicLinkDispatcherFake`) is already an AD-15 external-integration fake, but
// it only writes a log line — it records nothing a test can read. `um-auth-02`
// and `um-auth-06` must assert **zero** dispatch and `um-auth-01` must assert
// **exactly one** dispatch to a specific address (DEC-UM-004), and there is no
// other seam that exposes what the dispatcher was asked to send. So this is the
// documented AD-15 fake seam: we rebind the same outbound port to a
// recording variant of the same fake. Nothing else is overridden.
//
// DEC-UM-010 gate isolation: one worker (`--runInBand`), a collision-proof UUID
// namespace per run (`RunFixtures.runId`), each test deletes only rows it
// created, teardown steps wrapped so one failure never skips the rest. Reused
// verbatim from Epic 1 / Epic 0.
export {
  bearer,
  RunFixtures,
  relationExists,
  seedCurrentEmploymentStatus,
  type TestApp,
  type UserOverrides,
} from '../epic-1/fixtures';

/**
 * Recording variant of the production `MagicLinkDispatcherFake` (AD-15 outbound
 * fake). Same port, same no-op delivery — it just remembers every address it
 * was asked to dispatch to, so the enumeration-safety / single-dispatch
 * assertions (DEC-UM-004, DEC-UM-012) have something to read.
 */
export class RecordingMagicLinkDispatcher implements MagicLinkDispatcherPort {
  /** Every `workEmail` passed to `dispatch`, in call order. */
  readonly dispatched: string[] = [];

  /**
   * Every `dispatch` call as a `{ workEmail, token }` pair, in call order.
   *
   * Story 2.1 Stage 3 widens the port from `dispatch(workEmail)` to
   * `dispatch(workEmail, token)` — a real adapter needs the token to build the
   * emailed link (README decision 6). The second arg is optional here so this
   * fake still `implements MagicLinkDispatcherPort` before that widening lands;
   * `token` is simply `undefined` in the pre-Stage-3 world.
   */
  readonly records: Array<{ workEmail: string; token?: string }> = [];

  async dispatch(workEmail: string, token?: string): Promise<void> {
    this.dispatched.push(workEmail);
    this.records.push({ workEmail, token });
    await Promise.resolve();
  }

  /** Clear the log — call in `beforeEach` so counts are per-test. */
  reset(): void {
    this.dispatched.length = 0;
    this.records.length = 0;
  }

  /** How many dispatches targeted exactly this address. */
  countFor(workEmail: string): number {
    return this.dispatched.filter((email) => email === workEmail).length;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// `MagicLinkToken` table probes (Story 2.1 Stage 2)
//
// The `MagicLinkToken` entity is NOT in `prisma/schema.prisma` /
// `database-schema.md` yet — Story 2.1 Stage 3 adds it (proposed shape:
// `docs/test-cases/user-management/auth/README.md` decision 2, table
// `magic_link_token`, camelCase columns). Until then every probe below either
// reports "table absent" (`magicLinkTokenTableExists` → false) or throws a
// Postgres "relation does not exist" — which is exactly the committed-red state
// for `um-auth-01`'s "a token row was minted" assertion.
// ───────────────────────────────────────────────────────────────────────────

export interface MagicLinkTokenRow {
  id: string;
  userId: string;
  consumedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export async function magicLinkTokenTableExists(
  prisma: PrismaService,
): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.magic_link_token') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

export async function magicLinkTokenRowsForUser(
  prisma: PrismaService,
  userId: string,
): Promise<MagicLinkTokenRow[]> {
  return prisma.$queryRawUnsafe<MagicLinkTokenRow[]>(
    `SELECT id, "userId", "consumedAt", "expiresAt", "createdAt"
       FROM magic_link_token WHERE "userId" = $1`,
    userId,
  );
}

/** Total `magic_link_token` row count — for "exactly one new token" deltas. */
export async function magicLinkTokenCount(
  prisma: PrismaService,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM magic_link_token`,
  );
  return Number(rows[0]?.count ?? 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Story 2.2 (Consume a Magic-Link Token) Stage-2 helpers
//
// Story 2.1 SHIPPED `POST /auth/magic-link`, and the recording dispatcher above
// keeps every `{ workEmail, token }` pair it was asked to send. So a consume
// suite no longer needs the `<magic-link-token:alice>` placeholder — it mints a
// REAL token via the real route and reads the raw value back out of the fake,
// exactly as a real inbox would (nest-e2e.md "preconditions must be real": the
// mint request IS in this suite; the token is delivered out-of-band and the
// fake is the sanctioned AD-15 seam onto that channel).
// ───────────────────────────────────────────────────────────────────────────

/** SHA-256 hex of a raw token — the value stored in `magic_link_token.tokenHash`. */
export function tokenHashOf(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * The raw token the dispatcher was last asked to send to `workEmail`, or
 * `undefined` if none. Story 2.1's `MagicLinkService` passes the raw token as
 * `dispatch`'s second arg; `RecordingMagicLinkDispatcher` records it.
 */
export function rawTokenFor(
  dispatcher: RecordingMagicLinkDispatcher,
  workEmail: string,
): string | undefined {
  for (let i = dispatcher.records.length - 1; i >= 0; i -= 1) {
    const record = dispatcher.records[i];
    if (record.workEmail === workEmail) {
      return record.token;
    }
  }
  return undefined;
}

/** The `magic_link_token` row for a raw token value, or `null` if absent. */
export async function magicLinkTokenByRawToken(
  prisma: PrismaService,
  rawToken: string,
): Promise<MagicLinkTokenRow | null> {
  const rows = await prisma.$queryRawUnsafe<MagicLinkTokenRow[]>(
    `SELECT id, "userId", "consumedAt", "expiresAt", "createdAt"
       FROM magic_link_token WHERE "tokenHash" = $1`,
    tokenHashOf(rawToken),
  );
  return rows[0] ?? null;
}

/**
 * Back-date a minted token's `expiresAt` directly against the test DB — the
 * Stage-2 stand-in for "the TTL has elapsed" (DEC-UM-004: tests use a
 * controllable clock; no request represents the passage of time). Returns the
 * number of rows touched so a caller can assert the token existed.
 */
export async function backdateMagicLinkTokenExpiry(
  prisma: PrismaService,
  rawToken: string,
  expiresAt: Date = new Date(Date.now() - 60_000),
): Promise<number> {
  return prisma.$executeRawUnsafe(
    `UPDATE magic_link_token SET "expiresAt" = $1 WHERE "tokenHash" = $2`,
    expiresAt,
    tokenHashOf(rawToken),
  );
}

export interface AuthTestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  moduleFixture: TestingModule;
  /** The AD-15 recording fake bound behind `MAGIC_LINK_DISPATCHER_PORT`. */
  dispatcher: RecordingMagicLinkDispatcher;
}

/**
 * Boot the real app with the single AD-15 dispatcher seam in place. Mirrors
 * `bootstrapTestApp` (Epic 0/1) plus the `.overrideProvider` documented above
 * and the `ValidationPipe` re-enable (`nest-e2e.md` — bootstrap config is not
 * inherited by the test app).
 */
export async function bootstrapAuthTestApp(): Promise<AuthTestApp> {
  const dispatcher = new RecordingMagicLinkDispatcher();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAGIC_LINK_DISPATCHER_PORT)
    .useValue(dispatcher)
    .compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma, moduleFixture, dispatcher };
}

/**
 * Assert a response body carries NO session/access token under any of the
 * shapes Story 2.2 might land on. Used by every `/consume` failure case
 * (`um-auth-04/05/06`) — DEC-UM-004: no session token in a failure body.
 */
export function expectNoSessionToken(body: unknown): void {
  const record = (body ?? {}) as Record<string, unknown>;
  expect(record.accessToken).toBeUndefined();
  expect(record.sessionToken).toBeUndefined();
  expect(record.token).toBeUndefined();
  expect(record.session).toBeUndefined();
}

/** Pull whatever a `/consume` success body calls the session token. */
export function sessionTokenOf(body: unknown): unknown {
  const record = (body ?? {}) as Record<string, unknown>;
  return record.accessToken ?? record.sessionToken ?? record.token;
}
