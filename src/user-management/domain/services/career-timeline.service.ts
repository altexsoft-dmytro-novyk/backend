import { Inject, Injectable } from '@nestjs/common';
import type { UserEvent } from '../../../generated/prisma/client';
import {
  USER_EVENT_REPOSITORY_PORT,
  type SystemEventInput,
  type UserEventRepositoryPort,
} from '../interfaces/user-event.repository.port';

/** The author-supplied part of a manual backfill entry — everything the
 *  `POST /users/:id/events` action knows. `source` and the acting principal are
 *  stamped by the service, never passed in. */
export interface ManualEventParams {
  userId: string;
  type: string;
  eventDate: Date;
  details: Record<string, unknown>;
  createdBy: string;
}

// The `domain/services/` seam for the career-timeline event collection (AD-2:
// `application/actions/` depend on this service, never on a port token). It
// holds `USER_EVENT_REPOSITORY_PORT` the same way `UserService` holds the
// repository port; it never imports Prisma, HTTP types, or an adapter class.
@Injectable()
export class CareerTimelineService {
  constructor(
    @Inject(USER_EVENT_REPOSITORY_PORT)
    private readonly userEvents: UserEventRepositoryPort,
  ) {}

  listForUser(userId: string): Promise<UserEvent[]> {
    return this.userEvents.listForUser(userId);
  }

  /**
   * Story 3.2 — insert one manual backfill entry. `source` is server-stamped
   * `'manual'` here (a client can never set it); `createdBy` is the acting
   * principal passed by the action. Returns the created row for the `201` body.
   */
  addManualEvent(params: ManualEventParams): Promise<UserEvent> {
    return this.userEvents.add({ ...params, source: 'manual' });
  }

  /**
   * Story 3.3 — soft-delete one event, scoped to `(userId, eventId)`. Returns
   * `false` when no still-active event matches that scope (unknown id,
   * cross-timeline, or already soft-deleted); the action maps `false` to a
   * `NotFoundException`. Kept HTTP-free so `domain/` imports no NestJS
   * transport types.
   */
  async softDeleteEvent(userId: string, eventId: string): Promise<boolean> {
    const event = await this.userEvents.findActiveOnTimeline(userId, eventId);
    if (!event) {
      return false;
    }
    await this.userEvents.softDelete(event.id);
    return true;
  }

  /**
   * Build the `position_change` auto-event descriptor for a `PATCH /users/:id`
   * that actually changes `position` (AD-11). The caller passes it to
   * `UserService.update(..., systemEvents)` so it is written in the same
   * transaction as the `user.update`. `details` carries the NEW value only
   * (approved scenario um-ct-02 — no `from`/previous).
   */
  positionChangeEvent(
    userId: string,
    newPosition: string,
    editedBy: string,
  ): SystemEventInput {
    return {
      userId,
      type: 'position_change',
      // Today's calendar date in UTC (the column is `@db.Date`) — "в UTC, як і
      // інші всі дати" (Dmytro 2026-09-02).
      eventDate: new Date(new Date().toISOString().slice(0, 10)),
      details: { position: newPosition },
      source: 'system',
      createdBy: editedBy,
    };
  }
}
