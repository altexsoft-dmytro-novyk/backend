-- Epic 5 Story 5.1 — the AD-20 `Departure` aggregate (database-schema.md
-- §Departure, ratified). ADDITIVE ONLY. Hand-edited after `prisma migrate dev
-- --create-only`: the generator additionally emitted a DROP of
-- `PolicyPermissions_policy_fkey` (the composite FR/AR-type foreign key) and
-- `Policies_id_type_key` (its support index) — both are reviewed raw SQL from
-- `20260831070000_access_control_functional_roles` that Prisma cannot see in
-- `schema.prisma`, so its diff wrongly reads them as drift. Those DROP lines
-- were removed; this migration only creates the enum, table, indexes, FKs, and
-- the three raw-SQL constraints Prisma cannot express.

-- CreateEnum
CREATE TYPE "DepartureState" AS ENUM ('scheduled', 'processing', 'retry_wait', 'applied');

-- CreateTable
CREATE TABLE "departures" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "effectiveTimeZone" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "DepartureState" NOT NULL DEFAULT 'scheduled',
    "idempotencyKey" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMPTZ,
    "leaseUntil" TIMESTAMPTZ,
    "leaseToken" UUID,
    "appliedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "departures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "departures_idempotencyKey_key" ON "departures"("idempotencyKey");

-- CreateIndex
CREATE INDEX "departures_userId_idx" ON "departures"("userId");

-- CreateIndex
CREATE INDEX "departures_state_effectiveDate_id_idx" ON "departures"("state", "effectiveDate", "id");

-- AddForeignKey
ALTER TABLE "departures" ADD CONSTRAINT "departures_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departures" ADD CONSTRAINT "departures_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Raw-SQL constraints Prisma 7 cannot express (this repo does not enable the
-- `partialIndexes` Preview feature — see database-schema.md §Relationship
-- migration note).
-- ---------------------------------------------------------------------------

-- database-schema.md §Departure: "UNIQUE: one non-applied Departure per user".
-- A partial unique index on `userId` for every row that has not yet been
-- applied. `POST /users/:id/departures` catches the resulting P2002 and maps it
-- to `409 { error: 'departure_already_scheduled' }`.
CREATE UNIQUE INDEX "departures_one_non_applied_per_user"
  ON "departures"("userId")
  WHERE "state" <> 'applied';

-- database-schema.md §Departure: `dueAt` and `effectiveTimeZone` are resolved
-- once at creation and are never null (belt-and-suspenders over the column
-- NOT NULL — an explicit named guarantee, and it also forbids an empty zone
-- string).
ALTER TABLE "departures" ADD CONSTRAINT "departures_due_at_tz_present_check"
  CHECK ("dueAt" IS NOT NULL AND "effectiveTimeZone" IS NOT NULL AND "effectiveTimeZone" <> '');

-- database-schema.md §Departure state machine: the applied employment fact and
-- `appliedAt` move together — a row is `applied` iff `appliedAt` is set, and no
-- other state may carry an `appliedAt`. Story 5.2's worker predicates on this.
ALTER TABLE "departures" ADD CONSTRAINT "departures_applied_state_check"
  CHECK (("state" = 'applied') = ("appliedAt" IS NOT NULL));
