import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  DEPARTURE_EFFECTS_PORT,
  type DepartureEffectsParticipant,
} from '../domain/interfaces/departure-effects.port';
import type {
  DepartureExecutorPort,
  ProcessDueDeparturesResult,
  RetryDepartureOutcome,
} from '../domain/interfaces/departure-executor.port';
import { accessJournalIdempotencyKey } from './access-journal-idempotency';
import { DepartureMetricsService } from './departure-metrics.service';

// Epic 5 Story 5.2 (AD-20) — the effective-departure application worker.
//
// A PostgreSQL-backed polling worker: no in-memory `setTimeout(applyAt dueAt)`
// timer, the loop re-queries the DB each tick. `infrastructure/` because it
// touches Prisma directly (it is not an `application/` action). The `@Interval`
// loop is registered on `SchedulerRegistry` only when
// `DEPARTURE_WORKER_ENABLED === true`; `processDueDepartures()` / `requestRetry()`
// stay directly callable regardless (the E2E drives them — DEC-UM-004).
//
// SchedulerRegistry.addInterval is used instead of the static `@Interval(name,
// ms)` decorator only because the cadence is env-configured
// (`DEPARTURE_WORKER_POLL_MS`) and a decorator argument must be a compile-time
// constant; the mechanism is identical (a DB-polling loop, graceful shutdown via
// the registry).
const CLAIM_BATCH_SIZE = 20;
const LEASE_SECONDS = 120;
const RETRY_BACKOFF_BASE_SECONDS = 60;
const RETRY_BACKOFF_CAP_SECONDS = 3600;

interface ClaimedRow {
  id: string;
  leaseToken: string;
}

type ApplyOutcome = 'applied' | 'stale' | 'failed';

@Injectable()
export class DepartureWorkerService
  implements DepartureExecutorPort, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DepartureWorkerService.name);
  private readonly enabled: boolean;
  private readonly pollMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: DepartureMetricsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    config: ConfigService,
    @Inject(DEPARTURE_EFFECTS_PORT)
    private readonly effects: DepartureEffectsParticipant,
  ) {
    this.enabled =
      config.getOrThrow<boolean>('DEPARTURE_WORKER_ENABLED') === true;
    this.pollMs = config.getOrThrow<number>('DEPARTURE_WORKER_POLL_MS');
  }

  onApplicationBootstrap(): void {
    this.logger.log(
      `departure worker: enabled=${this.enabled} pollMs=${this.pollMs}`,
    );
    if (!this.enabled) {
      return;
    }
    const interval = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.schedulerRegistry.addInterval('departure-worker', interval);
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteInterval('departure-worker');
    } catch {
      // never registered (worker disabled) — nothing to clear.
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.processDueDepartures();
    } catch (error) {
      this.logger.error('departure worker tick failed', error as Error);
    }
  }

  // --- DepartureExecutorPort -------------------------------------------------

  async processDueDepartures(): Promise<ProcessDueDeparturesResult> {
    const claimed = await this.claimBatch();
    let applied = 0;
    let failed = 0;
    for (const row of claimed) {
      const outcome = await this.applyDeparture(row.id, row.leaseToken);
      if (outcome === 'applied') applied += 1;
      else if (outcome === 'failed') failed += 1;
    }
    if (claimed.length > 0) {
      this.logger.log(
        `departure worker batch: claimed=${claimed.length} applied=${applied} failed=${failed}`,
      );
    }
    return { claimed: claimed.length, applied, failed };
  }

  async requestRetry(
    userId: string,
    departureId: string,
  ): Promise<RetryDepartureOutcome> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ userId: string; state: string }>
    >(`SELECT "userId", state FROM "departures" WHERE id = $1`, departureId);
    const row = rows[0];
    if (!row || row.userId !== userId) {
      return 'not_found';
    }
    if (row.state !== 'retry_wait') {
      return 'not_retryable';
    }

    // Make the row immediately eligible without bypassing claim/fencing …
    await this.prisma.$executeRawUnsafe(
      `UPDATE "departures" SET "nextAttemptAt" = now()
        WHERE id = $1 AND state = 'retry_wait'`,
      departureId,
    );
    // … then run a synchronous, fenced claim+apply pass for just this row so the
    // outcome is deterministic for a caller (and the E2E) that does not wait for
    // the next poll. Two parallel retries: the `FOR UPDATE SKIP LOCKED` claim
    // lets exactly one proceed; the other no-ops.
    const claimed = await this.claimOne(departureId);
    if (claimed) {
      await this.applyDeparture(claimed.id, claimed.leaseToken);
    }
    return 'accepted';
  }

  // --- claim ---------------------------------------------------------------

  private eligiblePredicate(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `(
        (${p}state = 'scheduled'  AND ${p}"dueAt" <= now())
     OR (${p}state = 'retry_wait' AND ${p}"nextAttemptAt" <= now())
     OR (${p}state = 'processing' AND ${p}"leaseUntil" < now())
    )`;
  }

  private async claimBatch(): Promise<ClaimedRow[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ id: string; state: string }>
      >(
        `SELECT id, state FROM "departures"
          WHERE ${this.eligiblePredicate()}
          ORDER BY "effectiveDate", id
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        CLAIM_BATCH_SIZE,
      );
      const claimed: ClaimedRow[] = [];
      let reclaims = 0;
      for (const r of rows) {
        const token = await this.markProcessing(tx, r.id);
        if (!token) continue;
        if (r.state === 'processing') reclaims += 1;
        claimed.push({ id: r.id, leaseToken: token });
      }
      if (reclaims > 0) this.metrics.recordReclaimedLease(reclaims);
      return claimed;
    });
  }

  private async claimOne(departureId: string): Promise<ClaimedRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ id: string; state: string }>
      >(
        `SELECT id, state FROM "departures"
          WHERE id = $1 AND ${this.eligiblePredicate()}
          FOR UPDATE SKIP LOCKED`,
        departureId,
      );
      const r = rows[0];
      if (!r) return null;
      const token = await this.markProcessing(tx, r.id);
      if (!token) return null;
      if (r.state === 'processing') this.metrics.recordReclaimedLease();
      return { id: r.id, leaseToken: token };
    });
  }

  private async markProcessing(
    tx: Prisma.TransactionClient,
    departureId: string,
  ): Promise<string | null> {
    const updated = await tx.$queryRawUnsafe<Array<{ leaseToken: string }>>(
      `UPDATE "departures"
          SET state = 'processing',
              "leaseToken" = gen_random_uuid(),
              "leaseUntil" = now() + make_interval(secs => $1)
        WHERE id = $2
      RETURNING "leaseToken"`,
      LEASE_SECONDS,
      departureId,
    );
    return updated[0]?.leaseToken ?? null;
  }

  // --- apply -------------------------------------------------------------

  async applyDeparture(
    departureId: string,
    leaseToken: string,
  ): Promise<ApplyOutcome> {
    let attemptsBefore = 0;
    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<
          Array<{
            userId: string;
            createdBy: string;
            effectiveDate: Date;
            state: string;
            leaseToken: string | null;
            attempts: number | bigint | null;
          }>
        >(
          `SELECT "userId", "createdBy", "effectiveDate", state, "leaseToken", attempts
             FROM "departures" WHERE id = $1 FOR UPDATE`,
          departureId,
        );
        const row = rows[0];
        if (
          !row ||
          row.state !== 'processing' ||
          row.leaseToken !== leaseToken
        ) {
          // Stale / reclaimed executor — no effect, no retry-state mutation.
          return 'stale';
        }
        attemptsBefore = Number(row.attempts ?? 0);

        // (1) close the current `active` EmploymentStatus interval. The date is
        //     taken straight from the row in SQL — never round-tripped through a
        //     JS Date — so no timezone drift.
        await tx.$executeRawUnsafe(
          `UPDATE "employment_status" es
              SET "validTo" = d."effectiveDate"
             FROM "departures" d
            WHERE d.id = $1
              AND es."userId" = d."userId"
              AND es."validTo" IS NULL
              AND es.status = 'active'`,
          departureId,
        );

        // (2) insert the `dismissed` interval — the unique `sourceDepartureId`
        //     FK is the idempotency guard (a retry inserts nothing).
        await tx.$executeRawUnsafe(
          `INSERT INTO "employment_status"
             (id, "userId", status, "validFrom", "validTo", "sourceDepartureId", "departureReason")
           SELECT $2, d."userId", 'dismissed', d."effectiveDate", NULL, d.id, d.reason
             FROM "departures" d WHERE d.id = $1
           ON CONFLICT ("sourceDepartureId") DO NOTHING`,
          departureId,
          uuidv7(),
        );

        // (3) row-retention flag (idempotent).
        await tx.$executeRawUnsafe(
          `UPDATE "users" SET "isActive" = false WHERE id = $1`,
          row.userId,
        );

        // (4) persisted-access sweep — after Story 5.1 re-parenting this is a
        //     no-op; a residual grant is ended + journalled idempotently.
        await this.sweepPersistedAccess(
          tx,
          departureId,
          row.userId,
          row.createdBy,
        );

        // (5) cross-context participants (Action-Items, Mentorship) — a real
        //     no-op seam (PM/AD-23) until those contexts exist.
        await this.effects.applyDepartureEffects({
          departureId,
          departingUserId: row.userId,
          effectiveDate: row.effectiveDate,
          leaseToken,
          tx,
        });

        // (6) mark applied — fenced on the lease token.
        const marked = await tx.$executeRawUnsafe(
          `UPDATE "departures"
              SET state = 'applied', "appliedAt" = now(),
                  "leaseToken" = NULL, "leaseUntil" = NULL
            WHERE id = $1 AND "leaseToken" = $2 AND state = 'processing'`,
          departureId,
          leaseToken,
        );
        if (marked === 0) return 'stale';
        return 'applied';
      });
      if (outcome === 'applied') {
        this.logger.log(`departure ${departureId} applied`);
      }
      return outcome;
    } catch (error) {
      await this.moveToRetryWait(
        departureId,
        leaseToken,
        attemptsBefore,
        error,
      );
      return 'failed';
    }
  }

  private async sweepPersistedAccess(
    tx: Prisma.TransactionClient,
    departureId: string,
    userId: string,
    actorUserId: string,
  ): Promise<void> {
    const relationships = await tx.$queryRawUnsafe<
      Array<{ id: string; type: string }>
    >(
      `SELECT id, type FROM "relationships"
        WHERE "reportsToUserId" = $1 AND type IN ('direct', 'people_partner')`,
      userId,
    );
    const deptManagerLinks = await tx.$queryRawUnsafe<
      Array<{ policyId: string }>
    >(
      `SELECT up."policyId" AS "policyId"
         FROM "UserPolicies" up
         JOIN "Policies" p ON p.id = up."policyId"
        WHERE up."userId" = $1
          AND p.type = 'AR'
          AND p."targetType" = 'department'
          AND p."targetRole" = 'unit-manager'`,
      userId,
    );

    const journal: Prisma.AccessJournalCreateManyInput[] = [];
    for (const rel of relationships) {
      await tx.$executeRawUnsafe(
        `DELETE FROM "relationships" WHERE id = $1`,
        rel.id,
      );
      journal.push(
        this.revokeJournalRow(
          actorUserId,
          userId,
          departureId,
          `relationship:${rel.id}`,
        ),
      );
    }
    for (const link of deptManagerLinks) {
      await tx.$executeRawUnsafe(
        `DELETE FROM "UserPolicies" WHERE "userId" = $1 AND "policyId" = $2`,
        userId,
        link.policyId,
      );
      journal.push(
        this.revokeJournalRow(
          actorUserId,
          userId,
          departureId,
          `policy:${link.policyId}`,
        ),
      );
    }

    if (journal.length > 0) {
      await tx.accessJournal.createMany({
        data: journal,
        skipDuplicates: true,
      });
    }
  }

  private revokeJournalRow(
    actorUserId: string,
    subjectUserId: string,
    departureId: string,
    ref: string,
  ): Prisma.AccessJournalCreateManyInput {
    return {
      id: uuidv7(),
      actorUserId,
      subjectUserId,
      kind: 'full_profile_revoke',
      before: { departureId, ref },
      after: Prisma.JsonNull,
      idempotencyKey: accessJournalIdempotencyKey(
        actorUserId,
        subjectUserId,
        'full_profile_revoke',
        `${departureId}:${ref}`,
        'delete',
      ),
    };
  }

  private async moveToRetryWait(
    departureId: string,
    leaseToken: string,
    attemptsBefore: number,
    error: unknown,
  ): Promise<void> {
    const backoffSeconds = Math.min(
      RETRY_BACKOFF_BASE_SECONDS * 2 ** attemptsBefore,
      RETRY_BACKOFF_CAP_SECONDS,
    );
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "departures"
            SET state = 'retry_wait',
                attempts = attempts + 1,
                "lastError" = $1,
                "nextAttemptAt" = now() + make_interval(secs => $2),
                "leaseToken" = NULL,
                "leaseUntil" = NULL
          WHERE id = $3 AND "leaseToken" = $4 AND state = 'processing'`,
        sanitizeError(error),
        backoffSeconds,
        departureId,
        leaseToken,
      );
    } catch (retryError) {
      this.logger.error(
        `failed to move departure ${departureId} to retry_wait`,
        retryError as Error,
      );
    }
    this.logger.warn(
      `departure ${departureId} apply failed → retry_wait (attempt ${attemptsBefore + 1})`,
    );
  }
}

/** No PII, no message, no stack — just the error class name. */
function sanitizeError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `apply_failed:prisma_${error.code}`;
  }
  if (error instanceof Error && /^[A-Za-z0-9_]+$/.test(error.name)) {
    return `apply_failed:${error.name}`;
  }
  return 'apply_failed';
}
