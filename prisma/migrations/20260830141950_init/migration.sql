-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('direct', 'people_partner');

-- CreateEnum
CREATE TYPE "RelationshipJournalFieldType" AS ENUM ('manager', 'people_partner', 'department', 'department_manager', 'full_profile_access');

-- CreateEnum
CREATE TYPE "EmploymentStatusValue" AS ENUM ('active', 'dismissed');

-- CreateEnum
CREATE TYPE "UserEventSource" AS ENUM ('system', 'manual');

-- CreateEnum
CREATE TYPE "MagicLinkDispatchStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "photo" TEXT,
    "position" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "work_email" TEXT NOT NULL,
    "work_phone" TEXT,
    "birth_day" INTEGER,
    "birth_month" INTEGER,
    "company_join_date" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "tt_id" TEXT,
    "department_id" UUID NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" UUID NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "holder_user_id" UUID NOT NULL,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_hr_department" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" UUID,
    "manager_id" UUID,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_journal" (
    "id" UUID NOT NULL,
    "actor" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "field_type" "RelationshipJournalFieldType" NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationship_journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departures" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "departures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employment_statuses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "EmploymentStatusValue" NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3),

    CONSTRAINT "employment_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "source" "UserEventSource" NOT NULL,
    "event_date" TIMESTAMP(3) NOT NULL,
    "details" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "dispatch_status" "MagicLinkDispatchStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "magic_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_assignments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "project_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_permissions" (
    "policy_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "policy_permissions_pkey" PRIMARY KEY ("policy_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_policies" (
    "user_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,

    CONSTRAINT "user_policies_pkey" PRIMARY KEY ("user_id","policy_id")
);

-- CreateTable
CREATE TABLE "full_profile_access_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "full_profile_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_work_email_key" ON "users"("work_email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tt_id_key" ON "users"("tt_id");

-- CreateIndex
CREATE INDEX "users_department_id_idx" ON "users"("department_id");

-- CreateIndex
CREATE INDEX "relationships_holder_user_id_idx" ON "relationships"("holder_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_subject_user_id_type_key" ON "relationships"("subject_user_id", "type");

-- CreateIndex
CREATE INDEX "departments_parent_id_idx" ON "departments"("parent_id");

-- CreateIndex
CREATE INDEX "departments_manager_id_idx" ON "departments"("manager_id");

-- CreateIndex
CREATE INDEX "relationship_journal_subject_user_id_idx" ON "relationship_journal"("subject_user_id");

-- CreateIndex
CREATE INDEX "departures_user_id_idx" ON "departures"("user_id");

-- CreateIndex
CREATE INDEX "departures_effective_date_applied_at_idx" ON "departures"("effective_date", "applied_at");

-- CreateIndex
CREATE INDEX "employment_statuses_user_id_end_date_idx" ON "employment_statuses"("user_id", "end_date");

-- CreateIndex
CREATE INDEX "user_events_user_id_deleted_at_idx" ON "user_events"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_tokens_token_hash_key" ON "magic_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "magic_link_tokens_user_id_idx" ON "magic_link_tokens"("user_id");

-- CreateIndex
CREATE INDEX "project_assignments_project_id_idx" ON "project_assignments"("project_id");

-- CreateIndex
CREATE INDEX "project_assignments_user_id_idx" ON "project_assignments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_name_key" ON "policies"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE INDEX "policy_permissions_permission_id_idx" ON "policy_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_policies_policy_id_idx" ON "user_policies"("policy_id");

-- CreateIndex
CREATE INDEX "full_profile_access_grants_user_id_idx" ON "full_profile_access_grants"("user_id");

-- CreateIndex
CREATE INDEX "full_profile_access_grants_revoked_at_idx" ON "full_profile_access_grants"("revoked_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_holder_user_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_journal" ADD CONSTRAINT "relationship_journal_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departures" ADD CONSTRAINT "departures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employment_statuses" ADD CONSTRAINT "employment_statuses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_permissions" ADD CONSTRAINT "policy_permissions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_permissions" ADD CONSTRAINT "policy_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_policies" ADD CONSTRAINT "user_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_policies" ADD CONSTRAINT "user_policies_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "full_profile_access_grants" ADD CONSTRAINT "full_profile_access_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
