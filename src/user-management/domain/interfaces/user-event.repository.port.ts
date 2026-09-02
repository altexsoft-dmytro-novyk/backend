import type { UserEvent } from '../../../generated/prisma/client';

// UM-owned port for the `user_events` career-timeline sub-collection (Story 3.1,
// AD-11). It has two distinct concerns kept deliberately separate:
//
//  1. READ — `listForUser`, the `GET /users/:id/events` data source. Its Prisma
//     implementation is `infrastructure/user-event.repository.ts`; only
//     `CareerTimelineService` (a `domain/services/` seam) holds this token, and
//     `application/actions/` reach it through that service (AD-2).
//
//  2. WRITE — auto-events are written in the SAME transaction as the mutation
//     that triggers them (AD-11: explicit synchronous call, no event bus). The
//     domain layer cannot open a Prisma transaction, so the write is expressed
//     as a pure descriptor (`SystemEventInput`) that the User repository
//     co-writes inside its own `$transaction` (see `UserRepository.update`).
//     Story 3.2's manual `POST /users/:id/events` and Epic 4 Story 4.3's
//     `department_change` hook reuse the same descriptor shape.

/**
 * The immutable-on-write fields of one career-timeline event. `source` is
 * stamped by the caller (`'system'` for auto-events; `'manual'` for Story 3.2).
 * `eventDate` is a calendar date (the column is `@db.Date`).
 */
export interface SystemEventInput {
  userId: string;
  type: string;
  eventDate: Date;
  /** Event-type-specific payload; `{}` when the type carries none. */
  details: Record<string, unknown>;
  source: 'system' | 'manual';
  /** The acting principal — the editing viewer for `position_change`, the
   *  import operator for `joined_company`. */
  createdBy: string;
}

export interface UserEventRepositoryPort {
  /**
   * Every non-soft-deleted event for one user, chronological: `eventDate ASC`
   * then `createdAt ASC` as the stable tie-breaker. Soft-deleted rows
   * (`deletedAt IS NOT NULL`) are excluded.
   */
  listForUser(userId: string): Promise<UserEvent[]>;
}

export const USER_EVENT_REPOSITORY_PORT = Symbol('USER_EVENT_REPOSITORY_PORT');
