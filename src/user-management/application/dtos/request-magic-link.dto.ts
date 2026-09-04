import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

/**
 * `POST /auth/magic-link` body. `email` is required and must be email-shaped —
 * an empty body, a non-string, or a non-email value is a `400` from the global
 * `ValidationPipe` (auth/README decision 7), before anything is dispatched.
 *
 * The `@Transform` runs before validation (pipe `transform: true`), so a
 * whitespace-padded / differently-cased address (um-auth-01) both passes
 * `@IsEmail()` and reaches the handler already normalized (DEC-UM-007). Mirrors
 * `UpdateUserDto.workEmail`.
 */
export class RequestMagicLinkDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email!: string;
}
