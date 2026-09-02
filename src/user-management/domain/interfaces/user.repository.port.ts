import type { EmploymentStatus, User } from '../../../generated/prisma/client';
import type { UserEntity } from '../entities/user.entity';

export type UserEditPatch = Partial<Omit<UserEntity, 'customFields'>>;

export type UserListFilter = Partial<
  Pick<
    UserEntity,
    | 'firstName'
    | 'lastName'
    | 'position'
    | 'country'
    | 'city'
    | 'workEmail'
    | 'workPhone'
    | 'birthDay'
    | 'birthMonth'
    | 'companyJoinDate'
  >
> & { employmentStatus?: 'active' | 'dismissed' };

// A list row: the `User` plus its current (`validTo IS NULL`) employment-status
// fact, if any. A user with no current row is treated as `active` (README §6).
export type UserListRow = User & {
  employmentStatuses: Array<Pick<EmploymentStatus, 'status'>>;
};

export interface UserListPage {
  items: UserListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserRepositoryPort {
  create(props: UserEntity, createdBy: string): Promise<User>;
  findByWorkEmail(workEmail: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  update(id: string, patch: UserEditPatch): Promise<User>;
  deactivate(id: string): Promise<User>;
  list(
    filter: UserListFilter,
    page: number,
    pageSize: number,
  ): Promise<UserListPage>;
}

export const USER_REPOSITORY_PORT = Symbol('USER_REPOSITORY_PORT');
