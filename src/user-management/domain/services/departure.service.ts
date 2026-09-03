import { Inject, Injectable } from '@nestjs/common';
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
  retryDeparture(
    userId: string,
    departureId: string,
  ): Promise<RetryDepartureOutcome> {
    return this.executor.requestRetry(userId, departureId);
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
      return existing.requestHash === requestHash
        ? { kind: 'ok', view: this.toView(existing) }
        : {
            kind: 'conflict',
            body: { error: 'idempotency_key_payload_mismatch' },
          };
    }

    // Blocker check BEFORE any write.
    const blockers = await this.repository.loadPlatformBlockers(command.userId);
    if (hasPlatformBlockers(blockers)) {
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
      case 'idempotency_replay':
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

  reparent(command: {
    userId: string;
    targetId: string;
    actorId: string;
    expectedBlockerVersion: string;
  }): Promise<ReparentResult> {
    return this.repository.reparentPlatformBlockers(command);
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
