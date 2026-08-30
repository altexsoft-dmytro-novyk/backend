import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AccessControlAction } from '../actions/access-control.action';
import { verifySessionToken } from './session-token';

export interface AuthenticatedRequest extends Request {
  actorId: string;
}

// AD-23: 401 for missing/invalid/expired token. AC-AD-14: a due actor is
// denied 403 before any audience/feature resolution — checked here, once,
// globally, rather than duplicated in every route.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly accessControl: AccessControlAction) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException();
    }

    const claims = verifySessionToken(token);
    if (!claims) {
      throw new UnauthorizedException();
    }

    if (await this.accessControl.isDeparted(claims.userId)) {
      throw new ForbiddenException();
    }

    request.actorId = claims.userId;
    return true;
  }
}
