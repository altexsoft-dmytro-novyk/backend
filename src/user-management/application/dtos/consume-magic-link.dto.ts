import { IsNotEmpty, IsString } from 'class-validator';

/**
 * `POST /auth/magic-link/consume` body (auth/README decision 13). A missing,
 * empty, or non-string `token` is a `400` from the global `ValidationPipe`,
 * before any lookup — distinct from the generic `401` a well-formed but
 * invalid / expired / consumed token gets.
 */
export class ConsumeMagicLinkDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
