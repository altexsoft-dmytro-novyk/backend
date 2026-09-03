import { IsOptional, IsUUID } from 'class-validator';

// Story 4.2 — the optional optimistic-concurrency token for
// `DELETE /users/:employeeId/relationships/people-partner`
// (`?expectedCurrentTargetId=<ppId>`). Supplied + mismatched → `409`; omitted →
// the current PP is removed unconditionally (um-rel-16).
export class PeoplePartnerQueryDto {
  @IsUUID()
  @IsOptional()
  expectedCurrentTargetId?: string;
}
