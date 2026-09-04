import { IsOptional, IsUUID } from 'class-validator';

// Story 4.3 — the `PUT /departments/:deptId/manager` body. `managerUserId` is
// the new department manager; `expectedCurrentManagerId` is the
// optimistic-concurrency token (mirrors the people-partner edge, `um-rel-11`):
// omitted → first assignment only; present → must equal the current manager.
// The self-assignment check and the active-`User` target check live in the
// action, not here.
export class SetDepartmentManagerDto {
  @IsUUID()
  managerUserId!: string;

  @IsUUID()
  @IsOptional()
  expectedCurrentManagerId?: string;
}
