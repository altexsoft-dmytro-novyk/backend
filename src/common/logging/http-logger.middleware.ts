import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * One structured line per HTTP request, emitted when the response settles:
 * `finish` for a normal outcome — success, a guard `401`/`403`, a pipe `400`,
 * an unhandled `500` — and `close` for a connection the client aborted before
 * the response completed (logged `(aborted)` at `error`: a silently dropped
 * request is exactly the kind of failure worth seeing). The `500` stack is
 * logged separately by the `LoggingInterceptor` / Nest's exception handler.
 *
 * PII discipline (mirrors the rest of the backend): the request body and the
 * query string are never logged — the `/users` list filters carry names and
 * work emails. Only the method, the path (route ids included — they are already
 * in the access journal), the status, the duration, and the resolved actor id
 * (attached by `SessionGuard` as `req.session`, absent on unauthenticated
 * routes) are recorded.
 *
 * High-frequency, low-signal routes (health polling, the Swagger UI) are
 * skipped so one LB liveness probe every few seconds does not dominate the log.
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  // Matched against the path (query string already stripped). `originalUrl`
  // carries the global `/api` prefix and the `/v1` version segment.
  private static readonly SKIP_PATHS: readonly RegExp[] = [
    /^\/api\/(?:v\d+\/)?health$/,
    /^\/api\/docs/,
  ];

  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl.split('?')[0];
    if (HttpLoggerMiddleware.SKIP_PATHS.some((re) => re.test(path))) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    const { method } = req;
    let logged = false;

    const emit = (): void => {
      if (logged) {
        return;
      }
      logged = true;

      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const actor = (req as { session?: { userId?: string } }).session?.userId;
      const actorSuffix = actor ? ` actor=${actor}` : '';
      const aborted = !res.writableFinished;
      const line =
        `${method} ${path} ${res.statusCode}${aborted ? ' (aborted)' : ''} ` +
        `${ms.toFixed(1)}ms${actorSuffix}`;

      if (aborted || res.statusCode >= 500) {
        this.logger.error(line);
      } else if (res.statusCode >= 400) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    };

    // On a normal request `finish` fires first (and `close` is then a no-op via
    // the `logged` guard); on an abort only `close` fires, with
    // `writableFinished === false`.
    res.on('finish', emit);
    res.on('close', emit);

    next();
  }
}
