import {
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

// Story 3.2 — the `POST /users/:id/events` manual-backfill body.
//
// Only the three author-supplied fields are declared. Server-owned columns
// (`id`, `deletedAt`, `source`, `createdBy`) sent in the body are SILENTLY
// stripped by the global `whitelist` pipe — no 400 — consistent with the rest of
// UM's DTOs (um-ct-12 Test 3). `source` is always server-stamped `"manual"` and
// `createdBy` is always the authenticated actor.
export class CreateUserEventDto {
  // Event type is a free string at this stage (matches the `user_events.type`
  // column comment); the closed enum is a later concern.
  @IsString()
  @IsNotEmpty()
  type!: string;

  // A calendar date — the column is `@db.Date`. `@IsDateString` rejects
  // `"not-a-date"` with 400 (um-ct-12 Test 5); the action parses it to a UTC
  // `Date` ("в UTC, як і інші всі дати", Dmytro 2026-09-02).
  @IsDateString()
  eventDate!: string;

  // Event-type-specific payload; defaults to `{}` in the action when omitted.
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}
