/** Live functional-role permission lookup (AD-4 / CAP-4). */
export interface FunctionalRoleRepositoryPort {
  isAllowed(userId: string, permissionKey: string): Promise<boolean>;
}

export const FUNCTIONAL_ROLE_REPOSITORY_PORT = Symbol(
  'FUNCTIONAL_ROLE_REPOSITORY_PORT',
);
