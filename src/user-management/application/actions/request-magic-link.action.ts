import { Injectable } from '@nestjs/common';
import { MagicLinkService } from '../../domain/services/magic-link.service';

/**
 * Epic 2 Story 2.1 — `POST /auth/magic-link` use case. Thin by design: the
 * enumeration-safe behaviour lives in `MagicLinkService` (AD-2: actions call a
 * domain service, never a port).
 */
@Injectable()
export class RequestMagicLinkAction {
  constructor(private readonly magicLink: MagicLinkService) {}

  execute(email: string): Promise<void> {
    return this.magicLink.requestLink(email);
  }
}
