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

  async dispatch(workEmail: string): Promise<void> {
    this.dispatched.push(workEmail);
    await Promise.resolve();
  }

  /** Clear the log — call in `beforeEach` so counts are per-test. */
  reset(): void {
    this.dispatched.length = 0;
  }

  /** How many dispatches targeted exactly this address. */
  countFor(workEmail: string): number {
    return this.dispatched.filter((email) => email === workEmail).length;
  }
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
