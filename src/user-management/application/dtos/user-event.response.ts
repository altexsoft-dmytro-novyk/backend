import type { UserEvent } from '../../../generated/prisma/client';

// The `GET /users/:id/events` item shape (Story 3.1). Deliberately minimal:
//  - `deletedAt` is never exposed (soft-deleted rows are filtered out upstream).
//  - `createdBy` is never exposed (an internal authorship column, like `User`'s).
//  - `eventDate` is `@db.Date` — serialized as the date-only string the column
//    represents (`YYYY-MM-DD`), mirroring `toUserResponse`'s `companyJoinDate`.
export interface UserEventResponse {
  id: string;
  type: string;
  eventDate: string;
  details: unknown;
  source: string;
  createdAt: Date;
}

// The `GET /users/:id/events` success body — one person's owned timeline
// sub-collection plus the manual-mutation capability hint. NOT a pagination
// envelope (Stage-2 gate decision, Dmytro 2026-09-02).
export interface UserEventsEnvelope {
  data: UserEventResponse[];
  /** Whether this viewer may manually add/correct events — the Story 3.2/3.3
   *  dual gate. `false` for every viewer until Story 3.2 ships. */
  canEdit: boolean;
}

export function toUserEventResponse(event: UserEvent): UserEventResponse {
  return {
    id: event.id,
    type: event.type,
    eventDate: event.eventDate.toISOString().slice(0, 10),
    details: event.details,
    source: event.source,
    createdAt: event.createdAt,
  };
}
