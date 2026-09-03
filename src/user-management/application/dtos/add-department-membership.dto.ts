import { IsOptional, IsUUID } from 'class-validator';

// Story 4.3 — the `POST /users/:id/departments` body. `departmentId` is the
// department to add or move into; `fromDepartmentId`, when present, makes the
// `POST` an atomic named-source move (close the current membership in
// `fromDepartmentId`, add `departmentId` — one transaction). Absent →
// a plain add (the employee keeps every existing current membership).
// Server-owned fields sent in the body are stripped by the global `whitelist`
// pipe, consistent with the rest of UM's DTOs.
export class AddDepartmentMembershipDto {
  @IsUUID()
  departmentId!: string;

  @IsUUID()
  @IsOptional()
  fromDepartmentId?: string;
}
