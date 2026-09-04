import { Inject, Injectable, Logger } from '@nestjs/common';
import { BUSINESS_TIME_ZONE } from '../interfaces/business-time-zone.token';
import {
  DEPARTURE_EXECUTOR_PORT,
  type DepartureExecutorPort,
  type RetryDepartureOutcome,
} from '../interfaces/departure-executor.port';
import {
  DEPARTURE_REPOSITORY_PORT,
  type DepartureRecord,
  type DepartureRepositoryPort,
  type ReparentResult,
} from '../interfaces/departure.repository.port';
import {
  buildBlockedResponse,
  computeRequestHash,
  hasPlatformBlockers,
  normalizeReason,
  resolveDueAtUtc,
} from './departure.rules';

/** The `POST` / `GET` projection — the ratified `201` body plus, for
 *  non-`scheduled` states, sanitized worker diagnostics. Never carries
 *  `requestHash` / `idempotencyKey` / `leaseToken` / `nextAttemptAt`. */
export interface DepartureView {
  departureId: string;
  userId: string;
  state: string;
  effectiveDate: string;
  effectiveTimeZone: string;
  dueAt: string;
  reason: string;
  createdAt: string;
  attempts?: number;
  lastError?: string | null;
  /** Set once the worker has applied the departure (`state: 'applied'`). */
  appliedAt?: string | null;
}

export interface RecordDepartureCommand {
  userId: string;
  effectiveDate: string;
  reason: string;
  idempotencyKey: string;
  createdBy: string;
}

export type RecordDepartureOutcome =
  | { kind: 'ok'; view: DepartureView }
  | { kind: 'conflict'; body: Record<string, unknown> };

// The `domain/services/` seam for Story 5.1 (AD-2: `application/actions/` depend
// on this service, never on the port token). Holds `DEPARTURE_REPOSITORY_PORT`
// and the injected `BUSINESS_TIME_ZONE`; never imports Prisma, HTTP types, or an
// adapter class. HTTP status mapping lives in the actions.
@Injectable()
export class DepartureService {
  private readonly logger = new Logger(DepartureService.name);

  constructor(
    @Inject(DEPARTURE_REPOSITORY_PORT)
    private readonly repository: DepartureRepositoryPort,
    @Inject(BUSINESS_TIME_ZONE)
    private readonly businessTimeZone: string,
    @Inject(DEPARTURE_EXECUTOR_PORT)
    private readonly executor: DepartureExecutorPort,
  ) {}

  /** `POST /users/:id/departures/:departureId/retry` — delegates to the worker
   *  seam (claim/lease/fencing stays in `infrastructure/`). */
  async retryDeparture(
    userId: string,
    departureId: string,
  ): Promise<RetryDepartureOutcome> {
    const outcome = await this.executor.requestRetry(userId, departureId);
    this.logger.log(
      `departure retry requested for user ${userId} (departure ${departureId}) → ${outcome}`,
    );
    return outcome;
  }

  async recordDeparture(
    command: RecordDepartureCommand,
  ): Promise<RecordDepartureOutcome> {
    const requestHash = computeRequestHash({
      userId: command.userId,
      effectiveDate: command.effectiveDate,
      reason: command.reason,
      creatorId: command.createdBy,
    });

    // Idempotency lookup first — a replay never re-runs the blocker check and
    // never writes. Authorization was already rechecked by the guard.
    const existing = await this.repository.findByIdempotencyKey(
      command.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash === requestHash) {
        this.logger.log(
          `departure record: idempotent replay for user ${command.userId} (departure ${existing.id})`,
        );
        return { kind: 'ok', view: this.toView(existing) };
      }
      this.logger.warn(
        `departure record rejected: idempotency key payload mismatch for user ${command.userId}`,
      );
      return {
        kind: 'conflict',
        body: { error: 'idempotency_key_payload_mismatch' },
      };
    }

    // Blocker check BEFORE any write.
    const blockers = await this.repository.loadPlatformBlockers(command.userId);
    if (hasPlatformBlockers(blockers)) {
      this.logger.warn(
        `departure record blocked by responsibilities for user ${command.userId}`,
      );
      return {
        kind: 'conflict',
        body: buildBlockedResponse(command.userId, blockers),
      };
    }

    // A different key while a non-applied Departure already exists.
    const nonApplied = await this.repository.findNonAppliedByUser(
      command.userId,
    );
    if (nonApplied) {
      this.logger.warn(
        `departure record rejected: one already scheduled for user ${command.userId}`,
      );
      return {
        kind: 'conflict',
        body: { error: 'departure_already_scheduled' },
      };
    }

    const dueAt = resolveDueAtUtc(command.effectiveDate, this.businessTimeZone);
    const result = await this.repository.create({
      userId: command.userId,
      effectiveDate: command.effectiveDate,
      effectiveTimeZone: this.businessTimeZone,
      dueAt,
      reason: normalizeReason(command.reason),
      idempotencyKey: command.idempotencyKey,
      requestHash,
      createdBy: command.createdBy,
    });

    switch (result.outcome) {
      case 'created':
        this.logger.log(
          `departure recorded for user ${command.userId} (departure ${result.record.id}, effective ${command.effectiveDate}, by ${command.createdBy})`,
        );
        return { kind: 'ok', view: this.toView(result.record) };
      case 'idempotency_replay':
        this.logger.log(
          `departure record: idempotent replay for user ${command.userId} (departure ${result.record.id})`,
        );
        return { kind: 'ok', view: this.toView(result.record) };
      case 'idempotency_mismatch':
        return {
          kind: 'conflict',
          body: { error: 'idempotency_key_payload_mismatch' },
        };
      case 'already_scheduled':
        return {
          kind: 'conflict',
          body: { error: 'departure_already_scheduled' },
        };
    }
  }

  async getDeparture(
    userId: string,
    departureId: string,
  ): Promise<DepartureView | null> {
    const record = await this.repository.findByIdForUser(userId, departureId);
    return record ? this.toView(record) : null;
  }

  async reparent(command: {
    userId: string;
    targetId: string;
    actorId: string;
    expectedBlockerVersion: string;
  }): Promise<ReparentResult> {
    const result = await this.repository.reparentPlatformBlockers(command);
    if (result.outcome === 'stale') {
      this.logger.warn(
        `departure re-parent rejected: stale blocker version for user ${command.userId}`,
      );
    } else {
      this.logger.log(
        `departure blockers re-parented for user ${command.userId} onto ${command.targetId} by ${command.actorId} ` +
          `(directReports=${result.counts.directReports} departmentManager=${result.counts.departmentManager} peoplePartner=${result.counts.peoplePartnerAssignments})`,
      );
    }
    return result;
  }

  hasNonAppliedDeparture(userId: string): Promise<boolean> {
    return this.repository.hasNonAppliedDeparture(userId);
  }

  private toView(record: DepartureRecord): DepartureView {
    const view: DepartureView = {
      departureId: record.id,
      userId: record.userId,
      state: record.state,
      effectiveDate: record.effectiveDate.toISOString().slice(0, 10),
      effectiveTimeZone: record.effectiveTimeZone,
      dueAt: record.dueAt.toISOString(),
      reason: record.reason,
      createdAt: record.createdAt.toISOString(),
    };
    if (record.state !== 'scheduled') {
      // Sanitized diagnostics only — never the raw worker internals.
      view.attempts = record.attempts;
      view.lastError = record.lastError ? 'see operational logs' : null;
      view.appliedAt = record.appliedAt ? record.appliedAt.toISOString() : null;
    }
    return view;
  }
}
