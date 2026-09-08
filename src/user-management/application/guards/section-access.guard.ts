import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_CONTROL_PORT,
  type AccessControlPort,
} from '../../domain/interfaces/access-control.port';
import {
  REQUIRE_SECTION_ACCESS_KEY,
  type RequireSectionAccessMeta,
} from '../decorators/require-section-access.decorator';
import type { RequestWithSession } from './session.guard';

// The section-access route gate (SCP 2026-09-04 D3). Runs after SessionGuard —
// reads the session it attached to the request — and asks the UM-owned
// `ACCESS_CONTROL_PORT` exactly one question per route.
//
// The guard composes nothing: the rank comparison and the audience-first dual
// gate live behind `hasSectionAccess`, which is also what the `GET /users/:id`
// `canEdit` hint calls, so the route gate and the hint are literally one code
// path (see the story's Design Notes — two copies of one rule is the drift this
// story exists to remove).
//
// A handler with no `@RequireSectionAccess` metadata passes straight through,
// untouched, with no port call — every other route keeps whatever gate it has.
@Injectable()
export class SectionAccessGuard implements CanActivate {
  private readonly logger = new Logger(SectionAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_CONTROL_PORT)
    private readonly accessControl: AccessControlPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<RequireSectionAccessMeta | undefined>(
      REQUIRE_SECTION_ACCESS_KEY,
      context.getHandler(),
    );
    if (!meta) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const targetId = request.params.id as string;
    const allowed = await this.accessControl.hasSectionAccess(
      request.session.userId,
      meta.section,
      meta.level,
      targetId,
    );

    if (!allowed) {
      this.logger.warn(
        `access denied: user ${request.session.userId} lacks "${meta.level}"` +
          ` on section "${meta.section}" of target ${targetId} → 403`,
      );
      throw new ForbiddenException();
    }
    return true;
  }
}
