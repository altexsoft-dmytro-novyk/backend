// AD-1: domain-owned port for Story 5.1's record-departure write and its
// blocking precondition (AD-15). No Prisma/NestJS import here.
export const DEPARTURE_REPOSITORY_PORT = Symbol('DEPARTURE_REPOSITORY_PORT');

export interface DepartureRepositoryPort {
  userExists(userId: string): Promise<boolean>;

  /**
   * AD-15: true if `userId` still manages anyone (holds a `direct` edge as
   * holder), is anyone's People Partner (holds a `people_partner` edge as
   * holder), or manages any Department — the exact §4.16 blocking
   * condition, checked live via the same tables AD-5/AD-6 write to.
   */
  hasActiveManagedRelations(userId: string): Promise<boolean>;

  /** True if an unapplied Departure row already exists for userId. */
  hasPendingDeparture(userId: string): Promise<boolean>;

  recordDeparture(
    userId: string,
    effectiveDate: Date,
    reason: string,
    recordedBy: string,
  ): Promise<{
    id: string;
    userId: string;
    effectiveDate: Date;
    reason: string;
    recordedBy: string;
    recordedAt: Date;
    appliedAt: Date | null;
  }>;
}
