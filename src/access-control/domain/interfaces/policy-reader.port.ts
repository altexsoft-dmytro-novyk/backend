// AD-1: domain-owned port for access-control's own Policy/Permission/
// UserPolicy tables (AD-9). A port is still used (rather than a direct
// Prisma import here) to keep domain/ free of infrastructure imports even
// though these tables belong to this context.
export const POLICY_READER_PORT = Symbol('POLICY_READER_PORT');

export interface PolicyReaderPort {
  /** True if any policy attached to userId carries permissionName. */
  hasPermission(userId: string, permissionName: string): Promise<boolean>;

  /** True if userId has at least one UserPolicy row (any policy at all). */
  hasAnyPolicyAttached(userId: string): Promise<boolean>;

  /**
   * AD-9: the admin-facing functional-role catalog, with holder counts and
   * identities — um-seed-03 (FR-1/AD-12) reads this to prove exactly one
   * bootstrap user holds HR Admin.
   */
  listPolicies(): Promise<
    {
      id: string;
      name: string;
      holderCount: number;
      holders: { id: string; workEmail: string }[];
    }[]
  >;

  /** Detaches one policy from one user; no-op (does not throw) if absent. */
  revokeUserPolicy(userId: string, policyId: string): Promise<void>;
}
