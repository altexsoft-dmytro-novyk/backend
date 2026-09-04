import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ConsumeMagicLinkAction } from '../actions/consume-magic-link.action';
import { RequestMagicLinkAction } from '../actions/request-magic-link.action';
import { ConsumeMagicLinkDto } from '../dtos/consume-magic-link.dto';
import { RequestMagicLinkDto } from '../dtos/request-magic-link.dto';
import type { EstablishedSession } from '../../domain/services/magic-link.service';

/**
 * Epic 2 — Magic-Link Authentication. Own `/auth` root, no file overlap with the
 * `/users` resource (epic-2-context.md). Both routes are unauthenticated by
 * design — a caller has no session yet — so there are no guards here.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly requestMagicLink: RequestMagicLinkAction,
    private readonly consumeMagicLink: ConsumeMagicLinkAction,
  ) {}

  // Story 2.1. Enumeration-safe: the body is byte-identical for a known-active,
  // unknown, or deactivated address; a match dispatches exactly one link.
  @Post('magic-link')
  @HttpCode(HttpStatus.OK)
  async magicLink(@Body() dto: RequestMagicLinkDto): Promise<{ sent: true }> {
    await this.requestMagicLink.execute(dto.email);
    return { sent: true };
  }

  // Story 2.2. A valid unexpired unconsumed token whose owner is still active →
  // `200` + a session token (auth/README decision 9). Every other outcome —
  // not-found / expired / consumed / owner-inactive — is one generic `401` with
  // no session material in the body or headers (DEC-UM-004).
  @Post('magic-link/consume')
  @HttpCode(HttpStatus.OK)
  consume(@Body() dto: ConsumeMagicLinkDto): Promise<EstablishedSession> {
    return this.consumeMagicLink.execute(dto.token);
  }
}
