// AD-1: domain-owned port for the CAS-guarded organisational-relationship
// writes (AD-5 manager/PP edges, AD-6 department/department-manager) plus
// their AD-7 journal row. No Prisma/NestJS import here.
export const RELATIONSHIP_WRITE_REPOSITORY_PORT = Symbol(
  'RELATIONSHIP_WRITE_REPOSITORY_PORT',
);

export type RelationshipWriteField =
  'manager' | 'people_partner' | 'department' | 'department_manager';

// Every write returns the new holder/value (raw id or null) or the
// 'conflict' sentinel when an `expectedCurrent` the caller supplied no
// longer matches the locked current value (AD-5/AD-6 CAS contract).
export type RelationshipWriteResult =
  | { outcome: 'ok'; value: string | null }
  | { outcome: 'conflict' }
  | { outcome: 'not_found' };

export interface RelationshipWriteRepositoryPort {
  /**
   * AD-5: replace the `direct` (manager) or `people_partner` edge for
   * `subjectUserId`. Locks the current row (if any) with `SELECT ... FOR
   * UPDATE`, compares against `expectedCurrent` when supplied, deletes the
   * old edge and inserts the new one (or leaves absent if `newHolderId` is
   * null), and writes the AD-7 journal row — all in one transaction.
   */
  replaceRelationship(
    field: 'manager' | 'people_partner',
    actorId: string,
    subjectUserId: string,
    newHolderId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult>;

  /**
   * AD-6: replace `User.departmentId`. Locks the User row, compares against
   * `expectedCurrent`, updates the FK, writes the AD-7 journal row, and
   * appends a synchronous `department_change` UserEvents row (AD-19) — all
   * in one transaction.
   */
  changeDepartment(
    actorId: string,
    subjectUserId: string,
    newDepartmentId: string,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult>;

  /**
   * AD-6: replace `Department.managerId`. Locks the Department row,
   * compares against `expectedCurrent`, updates the FK, writes the AD-7
   * journal row — all in one transaction.
   */
  changeDepartmentManager(
    actorId: string,
    departmentId: string,
    newManagerId: string | null,
    expectedCurrent?: string | null,
  ): Promise<RelationshipWriteResult>;

  userExists(userId: string): Promise<boolean>;
  departmentExists(departmentId: string): Promise<boolean>;
}
