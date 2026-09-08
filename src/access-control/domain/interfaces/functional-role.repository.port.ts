/** Live functional-role permission lookup (AD-4 / CAP-4). */
export interface FunctionalRoleRepositoryPort {
  isAllowed(userId: string, permissionKey: string): Promise<boolean>;

  /** Point lookup backing the `DEFAULT_PERMISSIONS` baseline (PLAT-E4-S4.1a); `false` for a missing or inactive user. */
  isActiveUser(userId: string): Promise<boolean>;
}

export const FUNCTIONAL_ROLE_REPOSITORY_PORT = Symbol(
  'FUNCTIONAL_ROLE_REPOSITORY_PORT',
);
