-- Epic 2 Story 2.1 — Magic-Link Authentication (auth sub-area of user-management).
--
-- Adds `magic_link_token`: the one-time login-token store minted by
-- `POST /auth/magic-link`. `tokenHash` holds the SHA-256 hex of the raw token —
-- the raw token itself is only ever in the emailed link (a deliberate hardening
-- over `epic-2-context.md`'s `token`-unique draft; flagged for architect
-- ratification in `docs/architecture/database-schema.md` §MagicLinkToken).
--
-- NOTE: `prisma migrate dev` also emitted a `DROP CONSTRAINT
-- "PolicyPermissions_policy_fkey"` / `DROP INDEX "Policies_id_type_key"` pair —
-- those are the access-control functional-role raw-SQL constraints Prisma does
-- not track in the schema (same as the `20260902001941_story_1_1_import_population`
-- note). They are intentionally NOT included here; this migration is purely
-- additive.

-- CreateTable
CREATE TABLE "magic_link_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "consumedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_token_tokenHash_key" ON "magic_link_token"("tokenHash");

-- AddForeignKey
ALTER TABLE "magic_link_token" ADD CONSTRAINT "magic_link_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
