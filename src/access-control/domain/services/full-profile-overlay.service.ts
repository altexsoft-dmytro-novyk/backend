import { Inject, Injectable } from '@nestjs/common';
import {
  FULL_PROFILE_ACCESS_PORT,
  type FullProfileAccessPort,
} from '../interfaces/full-profile-access.port';

/**
 * CAP-5 facade subject: the §2.4 full-profile-access overlay
 * (PLAT-E4-S4.2c). Structurally parallel to `FunctionalRoleEvaluatorService`:
 * one injected port, one method delegating straight to it.
 *
 * Consulted by `AccessControlFacade.resolveSectionAccess` strictly AFTER the
 * existing best-of-audience merge, and only for a confirmed, active target —
 * never a fourth `Audience` label and never a row in `SECTION_ACCESS_MATRIX`
 * (`access-control.md:345`, "Overlay is not a matrix column").
 */
@Injectable()
export class FullProfileOverlayService {
  constructor(
    @Inject(FULL_PROFILE_ACCESS_PORT)
    private readonly port: FullProfileAccessPort,
  ) {}

  isHolder(userId: string): Promise<boolean> {
    return this.port.isActiveHolder(userId);
  }
}
