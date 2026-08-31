-- Access Control functional-role kernel (SPEC CAP-3, spine AD-4, FR-AMD-1).
--
-- Type separation between functional roles (FR) and access roles (AR) is the
-- whole point of this schema, and it is enforced HERE rather than in
-- application code. Prisma cannot express a partial unique index, a CHECK, a
-- unique support key, or a composite foreign key; leaving any of them to the
-- bootstrap would make the guarantee opt-in for every other writer that can
-- reach these tables.
--
-- The thirteen invariants this migration must satisfy are enumerated in
-- docs/architecture/database-schema.md § CAP-3 invariant coverage checklist,
-- and each is asserted by test/access-control/acm1r-fr-foundation.e2e-spec.ts.

-- CreateTable
CREATE TABLE "Policies" (
    "id" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT '==',
    "targetType" TEXT,
    "targetId" TEXT,
    "targetRole" TEXT,
    "type" TEXT NOT NULL,
    "managedBy" TEXT NOT NULL,
    CONSTRAINT "Policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    CONSTRAINT "Permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PolicyPermissions" (
    "policyId" TEXT NOT NULL,
    "policyType" TEXT NOT NULL DEFAULT 'FR',
    "permissionId" TEXT NOT NULL,
    CONSTRAINT "PolicyPermissions_pkey" PRIMARY KEY ("policyId", "permissionId")
);

CREATE TABLE "UserPolicies" (
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    CONSTRAINT "UserPolicies_pkey" PRIMARY KEY ("userId", "policyId")
);

CREATE TABLE "AccessControlBootstrap" (
    "key" TEXT NOT NULL,
    "normalizedRootEmail" TEXT NOT NULL,
    "rootUserId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    CONSTRAINT "AccessControlBootstrap_pkey" PRIMARY KEY ("key")
);

-- Invariant 1: `type` is restricted to the two kernel values. A third value is
-- as wrong as NULL, and NOT NULL alone would not catch it.
ALTER TABLE "Policies" ADD CONSTRAINT "Policies_type_check"
  CHECK ("type" IN ('FR', 'AR'));

-- Invariant 2: each type carries exactly its own shape. FR rows are global and
-- use no target sentinel; AR rows require both target columns.
ALTER TABLE "Policies" ADD CONSTRAINT "Policies_row_shape_check"
  CHECK (
    ("type" = 'FR' AND "targetRole" IS NOT NULL
                   AND "targetType" IS NULL AND "targetId" IS NULL)
    OR
    ("type" = 'AR' AND "targetType" IS NOT NULL AND "targetId" IS NOT NULL)
  );

-- Invariant 3: the FR role key is unique among FR rows ONLY. The predicate is
-- load-bearing — an AR policy carrying targetRole='hr-admin' is legal and is a
-- different object, never the functional role.
CREATE UNIQUE INDEX "Policies_targetRole_fr_key"
  ON "Policies"("targetRole")
  WHERE "type" = 'FR';

-- Invariant 4: the support key the composite foreign key below references. A
-- foreign key can only target a unique constraint, so without this the type
-- cannot be constrained by reference at all.
ALTER TABLE "Policies" ADD CONSTRAINT "Policies_id_type_key"
  UNIQUE ("id", "type");

-- Invariant 5: permission keys are append-only identities.
CREATE UNIQUE INDEX "Permissions_key_key" ON "Permissions"("key");

-- Invariant 7: the stored discriminator admits one value. Combined with the
-- composite foreign key below, this is what makes an AR-policy grant
-- unrepresentable rather than merely rejected by application validation.
ALTER TABLE "PolicyPermissions" ADD CONSTRAINT "PolicyPermissions_policyType_check"
  CHECK ("policyType" = 'FR');

-- Invariant 10: ACM-2 evaluates from a permission key, so the permission column
-- leads. The primary key already provides (policyId, permissionId); this index
-- is the other direction and is not redundant with it.
CREATE INDEX "PolicyPermissions_permissionId_policyId_idx"
  ON "PolicyPermissions"("permissionId", "policyId");

-- Invariant 8: the composite reference. `(policyId, 'FR')` can only resolve
-- against a policy row whose own `type` is 'FR', so a grant to an AR policy has
-- no referent. RESTRICT avoids silently deciding the deferred role-deletion
-- contract.
ALTER TABLE "PolicyPermissions" ADD CONSTRAINT "PolicyPermissions_policy_fkey"
  FOREIGN KEY ("policyId", "policyType") REFERENCES "Policies"("id", "type")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 9: a grant must name a real permission.
ALTER TABLE "PolicyPermissions" ADD CONSTRAINT "PolicyPermissions_permissionId_fkey"
  FOREIGN KEY ("permissionId") REFERENCES "Permissions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 11: attachments reference real users and real policies. The
-- composite primary key above already rejects a duplicate attachment.
ALTER TABLE "UserPolicies" ADD CONSTRAINT "UserPolicies_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserPolicies" ADD CONSTRAINT "UserPolicies_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "Policies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 12: a constrained singleton. The primary key alone would permit an
-- unbounded family of bootstrap rows under other keys, and "no singleton
-- recorded" would stop meaning "no provenance exists" — which is exactly the
-- condition that permits adoption on a first run.
ALTER TABLE "AccessControlBootstrap" ADD CONSTRAINT "AccessControlBootstrap_key_check"
  CHECK ("key" = 'root-hr-admin');

CREATE UNIQUE INDEX "AccessControlBootstrap_normalizedRootEmail_key"
  ON "AccessControlBootstrap"("normalizedRootEmail");
CREATE UNIQUE INDEX "AccessControlBootstrap_rootUserId_key"
  ON "AccessControlBootstrap"("rootUserId");
CREATE UNIQUE INDEX "AccessControlBootstrap_policyId_key"
  ON "AccessControlBootstrap"("policyId");

-- Invariant 13: RESTRICT on the singleton's own references too, so the root
-- User and the FR policy cannot be deleted out from under recorded provenance.
ALTER TABLE "AccessControlBootstrap" ADD CONSTRAINT "AccessControlBootstrap_rootUserId_fkey"
  FOREIGN KEY ("rootUserId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccessControlBootstrap" ADD CONSTRAINT "AccessControlBootstrap_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "Policies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
