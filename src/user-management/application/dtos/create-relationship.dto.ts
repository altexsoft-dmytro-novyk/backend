import { IsIn, IsUUID } from 'class-validator';

// Story 4.1 — the `POST /users/:id/relationships` body (AD-14 shape 4).
//
// `type` is `'direct'` only at this story: `type: 'project'` is sync-owned
// (PM/AD-31) and `type: 'people_partner'` is Story 4.2's `PUT` route. Anything
// else is a 400 from `@IsIn`. Server-owned fields sent in the body are silently
// stripped by the global `whitelist` pipe, consistent with the rest of UM's
// DTOs.
export class CreateRelationshipDto {
  @IsIn(['direct'])
  type!: 'direct';

  // The new manager. `@IsUUID` rejects a non-uuid target with 400; the
  // self-assignment check (`targetId === :id`) is in the action (400), not here.
  @IsUUID()
  targetId!: string;
}
