import { Inject, Injectable } from '@nestjs/common';
import {
  IDENTITY_CARD_ACCESS_PORT,
  type IdentityCardAccessPort,
} from '../interfaces/identity-card-access.port';

// The `domain/services/` seam for the identity-card `canEdit` hint (AD-2:
// `application/actions/` depend on a domain service, never on a port token).
// It holds `IDENTITY_CARD_ACCESS_PORT` the same way `UserService` holds the
// repository port; it never imports Prisma, HTTP types, or an adapter class.
@Injectable()
export class IdentityCardAccessService {
  constructor(
    @Inject(IDENTITY_CARD_ACCESS_PORT)
    private readonly identityCardAccess: IdentityCardAccessPort,
  ) {}

  canEdit(viewerId: string, targetUserId: string): Promise<boolean> {
    return this.identityCardAccess.canEditIdentityCard(viewerId, targetUserId);
  }
}
