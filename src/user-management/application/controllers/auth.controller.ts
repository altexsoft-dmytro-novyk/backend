import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AccessControlAction } from '../../../access-control/application/actions/access-control.action';
import { signSessionToken } from '../../../access-control/application/guards/session-token';
import { MagicLinkRepository } from '../../infrastructure/magic-link.repository';

// Epic 2 (epics.md Story 2.1/2.2): passwordless magic-link login — the sole
// authentication mechanism (FR-2). Unauthenticated routes, deliberately not
// under SessionAuthGuard.
//
// AD-22 enumeration safety: POST /auth/magic-link returns an identical 200
// body and dispatches nothing for an unknown, deactivated, or
// due-for-departure workEmail, exactly as for a known active one — checked
// via AD-17's live departure check (AccessControl.isDeparted), not only the
// materialized User.isActive flag, so a scheduled-but-not-yet-applied
// departure can't complete a login in the AD-16 executor's gap window.
//
// No email adapter exists in this build (see the auth E2E suite's own
// top-of-file note) — dispatchStatus is set to 'sent' at mint time as the
// closest real substitute for a real send attempt; there is nothing to
// retry against yet.
@Controller('auth')
export class AuthController {
  constructor(
    private readonly magicLinks: MagicLinkRepository,
    private readonly accessControl: AccessControlAction,
  ) {}

  @Post('magic-link')
  @HttpCode(200)
  async requestMagicLink(
    @Body() body: Record<string, unknown>,
  ): Promise<{ sent: true }> {
    const email = body.email;
    if (typeof email !== 'string' || email.trim().length === 0) {
      throw new BadRequestException();
    }
    const normalized = email.trim().toLowerCase();

    const user = await this.magicLinks.findActiveUserByEmail(normalized);
    if (user && user.isActive) {
      const departed = await this.accessControl.isDeparted(user.id);
      if (!departed) {
        await this.magicLinks.mint(user.id);
      }
    }

    // AD-22: identical response regardless of whether a token was minted.
    return { sent: true };
  }

  @Post('magic-link/consume')
  @HttpCode(200)
  async consumeMagicLink(
    @Body() body: Record<string, unknown>,
  ): Promise<{ accessToken: string }> {
    const token = body.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new BadRequestException();
    }

    const consumed = await this.magicLinks.tryConsume(token);
    if (!consumed) throw new UnauthorizedException();

    const user = await this.magicLinks.findActiveUserById(consumed.userId);
    if (!user || !user.isActive) throw new UnauthorizedException();
    if (await this.accessControl.isDeparted(user.id)) {
      throw new UnauthorizedException();
    }

    const accessToken = signSessionToken(user.id);
    return { accessToken };
  }
}
