import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  type EstablishedSession,
  MagicLinkService,
} from '../../domain/services/magic-link.service';

/**
 * Epic 2 Story 2.2 — `POST /auth/magic-link/consume` use case. Thin by design
 * (AD-2): the consume logic lives in `MagicLinkService`. This action maps the
 * domain's single generic failure (`null`) onto the bare `401` every denial
 * returns (DEC-UM-004) — no body fields, so no session material leaves the
 * endpoint on failure.
 */
@Injectable()
export class ConsumeMagicLinkAction {
  constructor(private readonly magicLink: MagicLinkService) {}

  async execute(token: string): Promise<EstablishedSession> {
    const session = await this.magicLink.consume(token);
    if (!session) {
      throw new UnauthorizedException();
    }
    return session;
  }
}
