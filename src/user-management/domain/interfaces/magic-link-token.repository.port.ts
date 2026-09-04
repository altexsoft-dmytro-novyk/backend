// Persistence port for the one-time magic-link token store (Epic 2 Story 2.1,
// extended in Story 2.2). The adapter (`infrastructure/magic-link-token.repository.ts`)
// is Prisma-backed; domain/application never see Prisma.

export interface MintMagicLinkTokenInput {
  userId: string;
  /** SHA-256 hex of the raw token — never the raw token itself. */
  tokenHash: string;
  expiresAt: Date;
}

/** The fields Story 2.2's consume flow reads about a stored token. */
export interface MagicLinkTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface MagicLinkTokenRepositoryPort {
  /** Insert one unconsumed token row. */
  mint(input: MintMagicLinkTokenInput): Promise<void>;

  /** The token row for this SHA-256 hex hash, or `null` when there is none. */
  findByHash(tokenHash: string): Promise<MagicLinkTokenRecord | null>;

  /**
   * Atomically mark the row spent: `UPDATE … SET consumedAt = now()
   * WHERE id = $1 AND consumedAt IS NULL`. Returns `true` iff this call was the
   * one that consumed it — a concurrent second caller gets `false` and no
   * session (single-use, DEC-UM-004 / auth/README decision 14).
   */
  markConsumed(id: string): Promise<boolean>;
}

export const MAGIC_LINK_TOKEN_REPOSITORY_PORT = Symbol(
  'MAGIC_LINK_TOKEN_REPOSITORY_PORT',
);
