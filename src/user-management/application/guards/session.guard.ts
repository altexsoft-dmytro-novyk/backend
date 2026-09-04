import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  SESSION_RESOLVER_PORT,
  type Session,
  type SessionResolverPort,
} from '../../domain/interfaces/session-resolver.port';

export interface RequestWithSession extends Request {
  session: Session;
}

@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger(SessionGuard.name);

  constructor(
    @Inject(SESSION_RESOLVER_PORT)
    private readonly sessionResolver: SessionResolverPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = await this.sessionResolver.resolve(
      request.headers.authorization,
    );
    if (!session) {
      this.logger.debug(
        `session unresolved for ${request.method} ${request.originalUrl.split('?')[0]} → 401`,
      );
      throw new UnauthorizedException();
    }

    request.session = session;
    return true;
  }
}
