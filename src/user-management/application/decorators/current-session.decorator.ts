import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Session } from '../../domain/interfaces/session-resolver.port';
import type { RequestWithSession } from '../guards/session.guard';

// Reads the session SessionGuard attached to the request — never resolves
// it itself. Only usable on routes guarded by SessionGuard.
export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Session => {
    const request = ctx.switchToHttp().getRequest<RequestWithSession>();
    return request.session;
  },
);
