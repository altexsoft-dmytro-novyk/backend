import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_CONTROL_PORT,
  type AccessControlPort,
} from '../../domain/interfaces/access-control.port';
import {
  REQUIRE_FEATURE_KEY,
  type RequireFeatureMeta,
} from '../decorators/require-feature.decorator';
import type { RequestWithSession } from './session.guard';

// Runs after SessionGuard — reads the session it attached to the request.
// A handler with no @RequireFeature[ForTarget] metadata is allowed through
// unchecked (session-only routes, if any are ever added).
@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_CONTROL_PORT)
    private readonly accessControl: AccessControlPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<RequireFeatureMeta | undefined>(
      REQUIRE_FEATURE_KEY,
      context.getHandler(),
    );
    if (!meta) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const isAllowed = meta.targetScoped
      ? await this.accessControl.isAllowedForTarget(
          request.session.userId,
          meta.feature,
          request.params.id as string,
        )
      : await this.accessControl.isAllowed(
          request.session.userId,
          meta.feature,
        );

    if (!isAllowed) {
      throw new ForbiddenException();
    }
    return true;
  }
}
