import { Inject, Injectable } from '@nestjs/common';
import type { UserEvent } from '../../../generated/prisma/client';
import {
  USER_EVENT_REPOSITORY_PORT,
  type SystemEventInput,
  type UserEventRepositoryPort,
} from '../interfaces/user-event.repository.port';

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
