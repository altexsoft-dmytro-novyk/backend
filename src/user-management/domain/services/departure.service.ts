import { Inject, Injectable } from '@nestjs/common';
import { DEPARTURE_REPOSITORY_PORT } from '../interfaces/departure-repository.port';
import type { DepartureRepositoryPort } from '../interfaces/departure-repository.port';

// Domain-level errors, transport-agnostic (AD-1) — the controller maps
// these to HTTP status codes.
export class TargetNotFoundError extends Error {}
export class StillManagingError extends Error {
  constructor() {
    super(
      'subject still manages at least one person, department, or PP assignment',
    );
  }
}
export class DeparturePendingError extends Error {
  constructor() {
    super('an unapplied departure is already recorded for this user');
  }
}

// AD-1: only domain/services/ may inject a port token.
@Injectable()
export class DepartureService {
  constructor(
    @Inject(DEPARTURE_REPOSITORY_PORT)
    private readonly repo: DepartureRepositoryPort,
  ) {}

  /**
   * Story 5.1 / AD-15: records a scheduled departure without touching
   * current EmploymentStatus — applying it is AD-16's executor's job, not
   * this call's. Blocked while the target still manages anyone/any
   * department/is anyone's PP (§4.16) — checked live, same tables AD-5/AD-6
   * write to, so a re-parent immediately before this call is honored.
   */
  async recordDeparture(
    targetId: string,
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
  }> {
    if (!(await this.repo.userExists(targetId))) {
      throw new TargetNotFoundError();
    }
    if (await this.repo.hasActiveManagedRelations(targetId)) {
      throw new StillManagingError();
    }
    if (await this.repo.hasPendingDeparture(targetId)) {
      throw new DeparturePendingError();
    }
    return this.repo.recordDeparture(
      targetId,
      effectiveDate,
      reason,
      recordedBy,
    );
  }
}
