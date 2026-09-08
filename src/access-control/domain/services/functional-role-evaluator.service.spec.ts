import type { FunctionalRoleRepositoryPort } from '../interfaces/functional-role.repository.port';
import { FunctionalRoleEvaluatorService } from './functional-role-evaluator.service';

describe('FunctionalRoleEvaluatorService — DEFAULT_PERMISSIONS union (PLAT-E4-S4.1a)', () => {
  const baselineKey = 'profile:identity:write';
  const otherKey = 'user-management:list';

  const makeRepository = () => {
    const isAllowed = jest.fn<Promise<boolean>, [string, string]>();
    const isActiveUser = jest.fn<Promise<boolean>, [string]>();
    const repository: FunctionalRoleRepositoryPort = {
      isAllowed,
      isActiveUser,
    };
    return { repository, isAllowed, isActiveUser };
  };

  it('allows a baseline key for an active user without consulting the grant chain', async () => {
    const { repository, isAllowed, isActiveUser } = makeRepository();
    isActiveUser.mockResolvedValue(true);
    const service = new FunctionalRoleEvaluatorService(repository);

    await expect(service.isAllowed('user-1', baselineKey)).resolves.toBe(true);
    expect(isAllowed).not.toHaveBeenCalled();
  });

  it('falls through to the grant chain for a baseline key when the user is inactive', async () => {
    const { repository, isAllowed, isActiveUser } = makeRepository();
    isActiveUser.mockResolvedValue(false);
    isAllowed.mockResolvedValue(false);
    const service = new FunctionalRoleEvaluatorService(repository);

    await expect(service.isAllowed('user-1', baselineKey)).resolves.toBe(false);
    expect(isAllowed).toHaveBeenCalledWith('user-1', baselineKey);
  });

  it('never calls isActiveUser for a non-baseline key', async () => {
    const { repository, isAllowed, isActiveUser } = makeRepository();
    isAllowed.mockResolvedValue(true);
    const service = new FunctionalRoleEvaluatorService(repository);

    await expect(service.isAllowed('user-1', otherKey)).resolves.toBe(true);
    expect(isActiveUser).not.toHaveBeenCalled();
    expect(isAllowed).toHaveBeenCalledWith('user-1', otherKey);
  });

  it('denies a non-baseline key with no matching grant', async () => {
    const { repository, isAllowed } = makeRepository();
    isAllowed.mockResolvedValue(false);
    const service = new FunctionalRoleEvaluatorService(repository);

    await expect(service.isAllowed('user-1', otherKey)).resolves.toBe(false);
  });
});
