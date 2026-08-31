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
import { NodemailerMagicLinkMailer } from '../../infrastructure/nodemailer-magic-link-mailer.adapter';

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
// Email delivery (NodemailerMagicLinkMailer) is wired in below. The send is
// best-effort: it runs only inside the enumeration-safe branch, its outcome
// is recorded on MagicLinkToken.dispatchStatus, and a transport failure is
// swallowed so POST /auth/magic-link stays a 200 either way (NFR-3). The
// mailer is injected as a concrete class, matching the pragmatic deviation
// already documented on MagicLinkRepository (full hexagon layering is
// access-control's own deliverable).
@Controller('auth')
export class AuthController {
  constructor(
    private readonly magicLinks: MagicLinkRepository,
    private readonly accessControl: AccessControlAction,
    private readonly mailer: NodemailerMagicLinkMailer,
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
        const minted = await this.magicLinks.mint(user.id);
        const outcome = await this.mailer.deliver({
          workEmail: user.workEmail,
          rawToken: minted.raw,
        });
        if (outcome === 'failed') {
          await this.magicLinks.markDispatchStatus(minted.id, 'failed');
        }
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
