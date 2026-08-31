-- Phase-0 access control: the org-fact edge table the audience walk recurses over.
-- Cardinality, shape and self-reference guards are enforced here: Prisma cannot
-- express partial unique indexes or CHECK constraints, and leaving them to
-- application code would make a fail-closed rule opt-in.

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('direct', 'project', 'people_partner');

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "reportsToUserId" TEXT,
    "projectId" TEXT,
    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- Indexes: the resolver filters (type, endpoint), so the endpoint leads.
CREATE INDEX "relationships_userId_type_idx" ON "relationships"("userId", "type");
CREATE INDEX "relationships_reportsToUserId_type_idx" ON "relationships"("reportsToUserId", "type");
CREATE INDEX "relationships_projectId_idx" ON "relationships"("projectId");

-- One live manager and one live People Partner per person. Project rows are
-- deliberately unconstrained here: a person may sit on many projects.
CREATE UNIQUE INDEX "relationships_one_direct_per_user"
  ON "relationships"("userId")
  WHERE "type" = 'direct';

CREATE UNIQUE INDEX "relationships_one_people_partner_per_user"
  ON "relationships"("userId")
  WHERE "type" = 'people_partner';

-- A row must carry exactly the endpoint its type means — a `direct` row with a
-- projectId, or a `project` row with no project, is malformed data that the
-- walk would otherwise have to guess about.
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_shape_check"
  CHECK (
    ("type" = 'direct' AND "reportsToUserId" IS NOT NULL AND "projectId" IS NULL)
    OR ("type" = 'people_partner' AND "reportsToUserId" IS NOT NULL AND "projectId" IS NULL)
    OR ("type" = 'project' AND "projectId" IS NOT NULL AND "reportsToUserId" IS NULL)
  );

-- Self-management would make the recursive walk cycle through its own start.
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_no_self_endpoint_check"
  CHECK ("reportsToUserId" IS NULL OR "reportsToUserId" <> "userId");

-- Foreign keys. RESTRICT on the endpoints keeps a dangling edge from ever
-- existing; deleting the subject cascades its own rows away.
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_reportsToUserId_fkey"
  FOREIGN KEY ("reportsToUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
