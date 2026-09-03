-- Epic 4 Story 4.3 — the `AccessJournal` subject for a `department_manager`
-- change is a Department, not a User. ADDITIVE ONLY. Hand-edited after
-- `prisma migrate dev --create-only`: the generator additionally emitted a DROP
-- of `PolicyPermissions_policy_fkey` (the composite FR/AR-type foreign key) and
-- `Policies_id_type_key` (its support index) — both are reviewed raw SQL from
-- `20260831070000_access_control_functional_roles` that Prisma cannot see in
-- `schema.prisma`, so its diff wrongly reads them as drift. Those DROP lines
-- were removed; this migration only widens `access_journal`.

-- AlterTable: `subjectUserId` becomes nullable; add the polymorphic
-- `subjectDepartmentId`. Every existing row keeps `subjectUserId` set.
ALTER TABLE "access_journal" ADD COLUMN     "subjectDepartmentId" TEXT,
ALTER COLUMN "subjectUserId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "access_journal" ADD CONSTRAINT "access_journal_subjectDepartmentId_fkey" FOREIGN KEY ("subjectDepartmentId") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one subject per row: a User subject (manager / people_partner /
-- membership rows) XOR a Department subject (department_manager rows). Existing
-- rows all have `subjectUserId` set and `subjectDepartmentId` NULL → they pass.
ALTER TABLE "access_journal" ADD CONSTRAINT "access_journal_one_subject_check" CHECK (num_nonnulls("subjectUserId", "subjectDepartmentId") = 1);
