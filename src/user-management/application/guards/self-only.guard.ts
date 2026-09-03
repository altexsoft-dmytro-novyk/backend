import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SELF_ONLY_KEY } from '../decorators/self-only.decorator';
import type { RequestWithSession } from './session.guard';

// Runs after SessionGuard / AccessControlGuard. On a route marked `@SelfOnly()`
// it enforces a plain identity comparison — the resolved session principal must
// equal the route's `:id` target — and denies `403` otherwise (no session is
// already `401` from SessionGuard). This is an identity rule, not a permission:
// it deliberately does NOT consult the access-control facade. A route with no
// `@SelfOnly()` metadata passes straight through.
@Injectable()
export class SelfOnlyGuard implements CanActivate {
  private readonly logger = new Logger(SelfOnlyGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const selfOnly = this.reflector.get<boolean | undefined>(
      SELF_ONLY_KEY,
      context.getHandler(),
    );
    if (!selfOnly) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const viewerId = request.session?.userId;
    const targetId = request.params.id;

    if (!viewerId || viewerId !== targetId) {
      this.logger.warn(
        `self-only denied: ${viewerId ?? 'anonymous'} attempted ${String(targetId)} → 403`,
      );
      throw new ForbiddenException();
    }
    return true;
  }
}
