import { Injectable, NotFoundException } from '@nestjs/common';
import { IdentityCardAccessService } from '../../domain/services/identity-card-access.service';
import { UserService } from '../../domain/services/user.service';
import {
  toUserCardResponse,
  type UserCardResponse,
} from '../dtos/user-card.response';

// CAP-3 — the `GET /users/:id` handler. Loads the target row (404 when absent,
// same as the retired `GetUserAction`) and computes the read-only `canEdit`
// dual-gate hint, then projects both through the S1-card envelope mapper.
//
// The audience gate for the read itself is enforced upstream by
// `AccessControlGuard` (`RequireFeatureForTarget('user-management:read')`);
// this action runs only once that has passed.
@Injectable()
export class GetUserCardAction {
  constructor(
    private readonly userService: UserService,
    private readonly identityCardAccess: IdentityCardAccessService,
  ) {}

  async execute(viewerId: string, id: string): Promise<UserCardResponse> {
    const user = await this.userService.findById(id);
    if (!user) {
      throw new NotFoundException();
    }
    const canEdit = await this.identityCardAccess.canEdit(viewerId, id);
    return toUserCardResponse(user, canEdit);
  }
}
