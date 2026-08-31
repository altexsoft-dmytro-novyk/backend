import { Inject, Injectable } from '@nestjs/common';
import {
  FUNCTIONAL_ROLE_REPOSITORY_PORT,
  type FunctionalRoleRepositoryPort,
} from '../interfaces/functional-role.repository.port';

/** CAP-4 facade subject: a live, data-driven global FR capability decision. */
@Injectable()
export class FunctionalRoleEvaluatorService {
  constructor(
    @Inject(FUNCTIONAL_ROLE_REPOSITORY_PORT)
    private readonly repository: FunctionalRoleRepositoryPort,
  ) {}

  isAllowed(userId: string, permissionKey: string): Promise<boolean> {
    return this.repository.isAllowed(userId, permissionKey);
  }
}
