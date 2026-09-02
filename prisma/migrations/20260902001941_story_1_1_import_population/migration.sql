-- Story 1.1 — seeded-population import (AD-16).
--
-- Adds the org-fact / lifecycle tables the idempotent import writer populates:
-- `department`, `department_membership`, `employment_status`, `user_events`.
--
-- Prisma 7 (without the `partialIndexes` Preview feature) cannot express the
-- partial unique indexes or the relaxed CHECK below, so they are reviewed raw
-- SQL here, matching the established constraint pattern in
-- `20260830010000_access_control_relationships` /
-- `20260831070000_access_control_functional_roles`.
--
-- NOTE: `prisma migrate dev --create-only` also emitted a `DROP CONSTRAINT
-- "PolicyPermissions_policy_fkey"` / `DROP INDEX "Policies_id_type_key"` pair —
-- those are the access-control functional-role raw-SQL constraints Prisma does
-- not track in the schema. They are intentionally NOT included here; this
-- migration is purely additive.

-- AlterTable
-- The seeded-population import has no source column for `city` (decisions §5)
-- and stores it null; request-level writers still set it.
ALTER TABLE "users" ALTER COLUMN "city" DROP NOT NULL;

-- CreateTable
CREATE TABLE "department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "parentId" TEXT,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,

    CONSTRAINT "department_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_status" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "departureReason" TEXT,
    -- Plain nullable column for now; the FK to `Departure` lands with AD-20 / Epic 5.
    "sourceDepartureId" TEXT,

    CONSTRAINT "employment_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Department identity is the (externalId, name) pair — the same timetracker
-- DepartmentId with a divergent name is a distinct department.
CREATE UNIQUE INDEX "department_externalId_name_key" ON "department"("externalId", "name");

-- CreateIndex
CREATE INDEX "department_membership_userId_idx" ON "department_membership"("userId");

-- CreateIndex
CREATE INDEX "department_membership_departmentId_idx" ON "department_membership"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "employment_status_sourceDepartureId_key" ON "employment_status"("sourceDepartureId");

-- CreateIndex
CREATE INDEX "employment_status_userId_idx" ON "employment_status"("userId");

-- CreateIndex
CREATE INDEX "user_events_userId_type_idx" ON "user_events"("userId", "type");

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_membership" ADD CONSTRAINT "department_membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_membership" ADD CONSTRAINT "department_membership_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_status" ADD CONSTRAINT "employment_status_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Reviewed raw-SQL constraints (Prisma 7 cannot express these).
-- ---------------------------------------------------------------------------

-- At most one CURRENT (validTo IS NULL) membership per (user, department). The
-- schema permits an employee to hold many current memberships across different
-- departments (database-schema.md §Project/Department "Multi-department
-- membership"); this only forbids a duplicate current row for the same pair.
CREATE UNIQUE INDEX "department_membership_one_current_per_user_department"
  ON "department_membership"("userId", "departmentId")
  WHERE "validTo" IS NULL;

-- At most one CURRENT employment-status row per user (database-schema.md
-- §EmploymentStatus).
CREATE UNIQUE INDEX "employment_status_one_current_per_user"
  ON "employment_status"("userId")
  WHERE "validTo" IS NULL;

-- Status domain.
ALTER TABLE "employment_status" ADD CONSTRAINT "employment_status_status_check"
  CHECK ("status" IN ('active', 'dismissed'));

-- Relaxed shape CHECK (database-schema.md §EmploymentStatus, "Import-origin
-- dismissals (2026-09-02)"): an `active` row still carries neither a departure
-- reference nor a reason; a `dismissed` row is unconstrained on those columns
-- (an import-origin dismissal predates the system and has no `Departure`).
ALTER TABLE "employment_status" ADD CONSTRAINT "employment_status_shape_check"
  CHECK (
    ("status" = 'active' AND "sourceDepartureId" IS NULL AND "departureReason" IS NULL)
    OR ("status" = 'dismissed')
  );

-- Career-event source domain.
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_source_check"
  CHECK ("source" IN ('system', 'manual'));
