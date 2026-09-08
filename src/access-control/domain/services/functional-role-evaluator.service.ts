import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_PERMISSIONS } from '../constants/default-permissions';
import {
  FUNCTIONAL_ROLE_REPOSITORY_PORT,
  type FunctionalRoleRepositoryPort,
} from '../interfaces/functional-role.repository.port';

/**
 * CAP-4 facade subject: a live global FR capability decision. PLAT-E4-S4.1a
 * (SCP sprint-change-proposal-2026-09-04-section-access-consolidation.md D2)
 * adds a code-defined baseline on top of the data-driven grant chain:
 * `isAllowed(user, key) = key ∈ DEFAULT_PERMISSIONS (active user) ∪ grant chain`.
 * The baseline point-lookup only runs for a `DEFAULT_PERMISSIONS` key, so
 * every other key keeps today's single-query grant-chain path unchanged.
 */
@Injectable()
export class FunctionalRoleEvaluatorService {
  constructor(
    @Inject(FUNCTIONAL_ROLE_REPOSITORY_PORT)
    private readonly repository: FunctionalRoleRepositoryPort,
  ) {}

  async isAllowed(userId: string, permissionKey: string): Promise<boolean> {
    if (DEFAULT_PERMISSIONS.has(permissionKey)) {
      const active = await this.repository.isActiveUser(userId);
      if (active) {
        return true;
      }
    }
    return this.repository.isAllowed(userId, permissionKey);
  }
}
