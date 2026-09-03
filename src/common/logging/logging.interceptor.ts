import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Adds a diagnostic line for anything thrown out of the handler chain
 * (controller → action → domain service → adapter), with the request context
 * the `HttpLoggerMiddleware` line cannot carry. It only observes: the error is
 * re-thrown unchanged, so the normal exception filter still renders the
 * response, and the middleware still logs the one request-summary line.
 *
 * - `>= 500` (or a non-`HttpException`): `error` with the stack — an actual
 *   fault.
 * - `4xx` `HttpException`: `debug` only — an expected refusal the middleware
 *   already records at `warn`; kept here so the reason is greppable at debug.
 *
 * Guard rejections (`SessionGuard` / `AccessControlGuard`) happen before any
 * interceptor, so those log their own reason line.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Request>();
    const target = `${req.method} ${req.originalUrl.split('?')[0]}`;
    const actor = (req as { session?: { userId?: string } }).session?.userId;
    const ctx = actor ? `${target} actor=${actor}` : target;

    return next.handle().pipe(
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        if (status >= 500) {
          this.logger.error(
            `${ctx} failed (${status})`,
            error instanceof Error ? error.stack : describeNonError(error),
          );
        } else {
          const message =
            error instanceof Error ? error.message : describeNonError(error);
          this.logger.debug(`${ctx} rejected (${status}): ${message}`);
        }
        return throwError(() => error);
      }),
    );
  }
}

/** A readable string for a thrown value that is not an `Error` — `String()` on
 *  a plain object is just `[object Object]`. */
function describeNonError(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
