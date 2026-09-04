// Epic 5 Story 5.2 (AD-20) — the seam the domain `DepartureService` calls to
// drive the effective-departure worker. The implementation
// (`infrastructure/departure-worker.service.ts`) touches Prisma directly and
// owns the `SELECT … FOR UPDATE SKIP LOCKED` claim loop, the `leaseToken`
// fencing, and the single apply `prisma.$transaction`.
//
// `application/actions/` never inject this token — only `domain/services/`
// (`DepartureService.processDueDepartures` / `.retryDeparture` delegate here).

export interface ProcessDueDeparturesResult {
  claimed: number;
  applied: number;
  failed: number;
}

export type RetryDepartureOutcome =
  /** The row was `retry_wait`; it was made immediately eligible and a synchronous
   *  claim+apply pass was run for it (deterministic for the E2E). */
  | 'accepted'
  /** No such departure, or it does not belong to the given user. */
  | 'not_found'
  /** The row exists but is not in `retry_wait` (`scheduled` / `processing` /
   *  `applied`). */
  | 'not_retryable';

export interface DepartureExecutorPort {
  /** Claim every currently-eligible departure (`scheduled` past `dueAt`;
   *  `retry_wait` past `nextAttemptAt`; `processing` past `leaseUntil`) and apply
   *  each under its own fenced transaction. Safe to call concurrently. */
  processDueDepartures(): Promise<ProcessDueDeparturesResult>;

  /** `POST /users/:id/departures/:departureId/retry` support. */
  requestRetry(
    userId: string,
    departureId: string,
  ): Promise<RetryDepartureOutcome>;
}

export const DEPARTURE_EXECUTOR_PORT = Symbol('DEPARTURE_EXECUTOR_PORT');
