-- Epic 4 Story 4.2 (increment PLAT-E4-S4.2c) — the §2.4 full-profile-access
-- overlay data model (`FullProfileGrant`). ADDITIVE ONLY. Hand-edited after
-- `prisma migrate dev --create-only`: the generator additionally emitted a
-- DROP of `PolicyPermissions_policy_fkey` (the composite FR/AR-type foreign
-- key) and `Policies_id_type_key` (its support index) — both are reviewed raw
-- SQL from `20260831070000_access_control_functional_roles` that Prisma
-- cannot see in `schema.prisma`, so its diff wrongly reads them as drift, the
-- same false-positive `20260903011657_story_4_1_access_journal`'s own header
-- comment already records. Those DROP lines are removed; this migration only
-- creates the table, its indexes, its foreign keys, and the two raw-SQL
-- constraints Prisma cannot express (the partial unique "current holder"
-- index, and the no-self-assignment CHECK).

-- CreateTable
CREATE TABLE "full_profile_grants" (
    "id" TEXT NOT NULL,
    "holderUserId" TEXT NOT NULL,
    "grantedByUserId" TEXT,
    "grantedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedByUserId" TEXT,
    "revokedAt" TIMESTAMPTZ,

    CONSTRAINT "full_profile_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "full_profile_grants_holderUserId_idx" ON "full_profile_grants"("holderUserId");

-- AddForeignKey
ALTER TABLE "full_profile_grants" ADD CONSTRAINT "full_profile_grants_holderUserId_fkey" FOREIGN KEY ("holderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "full_profile_grants" ADD CONSTRAINT "full_profile_grants_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "full_profile_grants" ADD CONSTRAINT "full_profile_grants_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Reviewed raw-SQL constraints (Prisma 7 cannot express these), matching the
-- established pattern in `20260830010000_access_control_relationships` /
-- `20260902001941_story_1_1_import_population`.
-- ---------------------------------------------------------------------------

-- No self-assignment: a grant row must never name its own holder as its own
-- grantor. The `IS NULL OR` clause is what lets the one bootstrap-seeded row
-- (root granting itself the first holder slot, `grantedByUserId` NULL)
-- through without weakening the rule for every ordinary grant — mirrors
-- `relationships_no_self_endpoint_check`
-- (`CHECK ("reportsToUserId" IS NULL OR "reportsToUserId" <> "userId")`).
ALTER TABLE "full_profile_grants" ADD CONSTRAINT "full_profile_grants_no_self_grant_check"
  CHECK ("grantedByUserId" IS NULL OR "grantedByUserId" <> "holderUserId");

-- At most one CURRENT (revokedAt IS NULL) grant per holder — mirrors
-- `relationships_one_direct_per_user` /
-- `department_membership_one_current_per_user_department`. Lets a holder be
-- re-granted after a prior revoke without a global unique blocking it.
CREATE UNIQUE INDEX "full_profile_grants_one_current_per_holder"
  ON "full_profile_grants"("holderUserId")
  WHERE "revokedAt" IS NULL;
