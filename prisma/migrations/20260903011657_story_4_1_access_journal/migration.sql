-- Epic 4 Story 4.1 — the §3.4 access journal (PM/AD-29, database-schema.md
-- §AccessJournal). ADDITIVE ONLY. Hand-edited after `prisma migrate dev
-- --create-only`: the generator additionally emitted a DROP of
-- `PolicyPermissions_policy_fkey` (the composite FR/AR-type foreign key) and
-- `Policies_id_type_key` (its support index) — both are reviewed raw SQL from
-- `20260831070000_access_control_functional_roles` that Prisma cannot see in
-- `schema.prisma`, so its diff wrongly reads them as drift. Those DROP lines
-- were removed; this migration only creates the enum, table, indexes and FKs.

-- CreateEnum
CREATE TYPE "AccessJournalKind" AS ENUM ('manager', 'people_partner', 'department_membership', 'department_manager', 'full_profile_grant', 'full_profile_revoke', 'shared_link_access');

-- CreateTable
CREATE TABLE "access_journal" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "subjectUserId" TEXT NOT NULL,
    "kind" "AccessJournalKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "access_journal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_journal_idempotencyKey_key" ON "access_journal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "access_journal_subjectUserId_occurredAt_idx" ON "access_journal"("subjectUserId", "occurredAt");

-- AddForeignKey
ALTER TABLE "access_journal" ADD CONSTRAINT "access_journal_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_journal" ADD CONSTRAINT "access_journal_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
