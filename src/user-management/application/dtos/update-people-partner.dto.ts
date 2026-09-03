import { IsOptional, IsUUID } from 'class-validator';

// Story 4.2 — the `PUT /users/:employeeId/relationships/people-partner` body
// (AD-14 shape 4). `expectedCurrentTargetId` is the optimistic-concurrency token
// that replaces api-conventions.md shape 4's ETag-less `If-Match: "<pp-user-id>"`
// (there is no ETag source). The self-assignment check (`targetId === :id`) and
// the active-`User` target check live in the action, not here.
export class UpdatePeoplePartnerDto {
  @IsUUID()
  targetId!: string;

  @IsUUID()
  @IsOptional()
  expectedCurrentTargetId?: string;
}
