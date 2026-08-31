// ACM-1 / SPEC CAP-3 — the deploy-time functional-role bootstrap.
//
// Runs after `npm run db:seed` (CAP-8/ACM-0, which creates and validates the
// normalized active root User) and before `start:prod`. Deployment order is
// db:deploy -> db:seed -> db:bootstrap:access-control -> start:prod.
//
// Ownership is a SET OF SPECIFIC ROWS, not the contents of these tables: the
// three canonical permission keys, the FR `hr-admin` policy, their three
// canonical grant pairs, the normalized root attachment, and the
// `AccessControlBootstrap` singleton. Everything else in the same tables
// belongs to administrators under a later approved catalog contract and is
// preserved. A rerun that pruned back to the canonical set would revoke
// approved access on every deployment.
import { PrismaPg } from '@prisma/adapter-pg';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../../../generated/prisma/client';

export const BOOTSTRAP_KEY = 'root-hr-admin';
export const FR_ROLE = 'hr-admin';
const LOCK_NAME = 'access-control:bootstrap:root-hr-admin';

export const CANONICAL_PERMISSIONS = [
  {
    key: 'user-management:create',
    description: 'Create a user in User Management.',
  },
  {
    key: 'user-management:deactivate',
    description: 'Deactivate a user in User Management.',
  },
  {
    key: 'user-management:list',
    description: 'List users in User Management.',
  },
] as const;

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** DEC-UM-007. The same rule ACM-0 applies when it STORES the value. */
const normalizeWorkEmail = (workEmail: string) => workEmail.trim().toLowerCase();

export class AccessControlBootstrapError extends Error {
  constructor(message: string) {
    super(`Access Control bootstrap: ${message}`);
    this.name = 'AccessControlBootstrapError';
  }
}

const fail = (message: string): never => {
  throw new AccessControlBootstrapError(message);
};

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

function lockTimeoutMs(): number {
  // Operational configuration of a deploy-time step: environments differ in how
  // long a concurrent deploy may legitimately hold the lock.
  const raw = process.env.ACCESS_CONTROL_BOOTSTRAP_LOCK_TIMEOUT_MS;
  if (!raw) return DEFAULT_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_TIMEOUT_MS;
}

/**
 * The common serialization point. Taken BEFORE any bootstrap-state inspection,
 * including the read that discovers the state is empty — locking the singleton
 * row instead would acquire nothing on a fresh database, and two concurrent
 * first runs would race straight past each other.
 *
 * Polled with `pg_try_advisory_xact_lock` rather than the blocking variant so
 * the timeout and its diagnostic are ours rather than a generic server error.
 */
async function acquireBootstrapLock(tx: Tx): Promise<void> {
  const deadline = Date.now() + lockTimeoutMs();
  for (;;) {
    const [{ locked }] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
      LOCK_NAME,
    );
    if (locked) return;
    if (Date.now() >= deadline) {
      fail(
        `lock timeout after ${lockTimeoutMs()}ms waiting for the bootstrap advisory lock ` +
          `"${LOCK_NAME}". Another bootstrap run is holding it. Retry once that run finishes; ` +
          `nothing was written.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type RootCandidate = { id: string; workEmail: string; isActive: boolean };

/**
 * Exact-one eligibility, counting ALL normalized matches BEFORE consulting
 * active state, so a count other than one fails as unmatched or ambiguous
 * rather than silently selecting the live row of a case-only duplicate pair.
 */
async function locateRoot(
  tx: Tx,
  normalizedRootEmail: string,
): Promise<RootCandidate> {
  const everyone = await tx.user.findMany({
    select: { id: true, workEmail: true, isActive: true },
  });
  const matches = everyone.filter(
    ({ workEmail }) => normalizeWorkEmail(workEmail) === normalizedRootEmail,
  );

  if (matches.length === 0) {
    fail(
      `unmatched root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" has 0 matches. ` +
        `Run \`npm run db:seed\` first, or correct the configured root identity.`,
    );
  }
  if (matches.length > 1) {
    const conflicts = matches
      .map(({ id, isActive }) => `${id} (isActive=${isActive})`)
      .join(', ');
    fail(
      `ambiguous root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" has ` +
        `${matches.length} matches: ${conflicts}. Reconcile duplicate normalized workEmail values.`,
    );
  }

  // Lock the candidate row, then RE-READ it. An unlocked read can be
  // invalidated again before commit; this is what makes the pre-commit
  // revalidation below meaningful rather than decorative.
  const candidate = matches[0];
  await tx.$queryRawUnsafe(
    `SELECT id FROM "users" WHERE id = $1 FOR UPDATE`,
    candidate.id,
  );
  const locked = await tx.user.findUnique({
    where: { id: candidate.id },
    select: { id: true, workEmail: true, isActive: true },
  });

  if (!locked) {
    fail(
      `root identity ${candidate.id} disappeared while the bootstrap held its transaction. Nothing was written.`,
    );
  }
  if (normalizeWorkEmail(locked!.workEmail) !== normalizedRootEmail) {
    fail(
      `root identity ${candidate.id} changed its workEmail to "${locked!.workEmail}" while the ` +
        `bootstrap held its transaction; it no longer matches "${normalizedRootEmail}". Nothing was written.`,
    );
  }
  if (!locked!.isActive) {
    fail(
      `inactive root identity: "${normalizedRootEmail}" resolves to ${candidate.id}, which is no longer ` +
        `active. Exactly one ACTIVE normalized match is required. Nothing was written.`,
    );
  }
  return locked!;
}

type FrPolicy = {
  id: string;
  operator: string;
  managedBy: string;
  targetType: string | null;
  targetId: string | null;
};

/**
 * Natural-key lookup, ALWAYS filtered to `type='FR'`. An AR policy carrying
 * targetRole='hr-admin' is legal under the partial unique index and is a
 * different object: never adopted, mutated, counted, or reported as drift.
 * Matching on targetRole alone is the single mistake that produces all four of
 * those failures at once.
 */
async function findFrPolicy(tx: Tx): Promise<FrPolicy | null> {
  const rows = await tx.$queryRawUnsafe<FrPolicy[]>(
    `SELECT id, operator, "managedBy", "targetType", "targetId"
     FROM "Policies" WHERE type = 'FR' AND "targetRole" = $1 FOR UPDATE`,
    FR_ROLE,
  );
  return rows[0] ?? null;
}

/** The FR-AMD-1 drift table, Policies rows: every field here fails rather than restores. */
function assertCanonicalPolicyShape(policy: FrPolicy): void {
  if (policy.operator !== '==') {
    fail(
      `conflicting drift on the FR "${FR_ROLE}" policy: operator is "${policy.operator}", canonical is "==". ` +
        `No other operator is supported in this MVP. Nothing was written.`,
    );
  }
  if (policy.managedBy !== 'admin') {
    fail(
      `conflicting drift on the FR "${FR_ROLE}" policy: managedBy is "${policy.managedBy}", canonical is ` +
        `"admin". "sync" provenance is reserved to the timetracker integration. Nothing was written.`,
    );
  }
  if (policy.targetType !== null || policy.targetId !== null) {
    fail(
      `conflicting drift on the FR "${FR_ROLE}" policy: FR rows carry no target, but targetType=` +
        `"${policy.targetType}" targetId="${policy.targetId}". Nothing was written.`,
    );
  }
}

/** Restores missing canonical keys; never rewrites an id or a description. */
async function ensurePermissions(tx: Tx): Promise<string[]> {
  const ids: string[] = [];
  for (const { key, description } of CANONICAL_PERMISSIONS) {
    const existing = await tx.permission.findUnique({
      where: { key },
      select: { id: true },
    });
    if (existing) {
      // Descriptive text is not authorization-bearing: an administrator's edit
      // stands. The generated id is matched on `key` and never rewritten.
      ids.push(existing.id);
      continue;
    }
    const created = await tx.permission.create({
      data: { id: uuidv7(), key, description },
      select: { id: true },
    });
    ids.push(created.id);
  }
  return ids;
}

/** Ensures the three canonical pairs are PRESENT — not that they are the only ones. */
async function ensureGrants(
  tx: Tx,
  policyId: string,
  permissionIds: string[],
): Promise<void> {
  for (const permissionId of permissionIds) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "PolicyPermissions" ("policyId", "policyType", "permissionId")
       VALUES ($1, 'FR', $2)
       ON CONFLICT ("policyId", "permissionId") DO NOTHING`,
      policyId,
      permissionId,
    );
  }
}

async function attachmentExists(
  tx: Tx,
  userId: string,
  policyId: string,
): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<{ userId: string }[]>(
    `SELECT "userId" FROM "UserPolicies" WHERE "userId" = $1 AND "policyId" = $2 FOR UPDATE`,
    userId,
    policyId,
  );
  return rows.length > 0;
}

export async function bootstrapAccessControl(prisma: PrismaClient): Promise<void> {
  const configured = process.env.ROOT_WORK_EMAIL;
  if (!configured || configured.trim() === '') {
    fail(
      `ROOT_WORK_EMAIL is blank or unset. A deployment must not come up with no root identity; ` +
        `set it to the intended root work email and rerun. Nothing was written.`,
    );
  }
  const normalizedRootEmail = normalizeWorkEmail(configured!);

  await prisma.$transaction(
    async (tx) => {
      await acquireBootstrapLock(tx);

      // Provenance first: its ABSENCE is what permits adoption below.
      const [singleton] = await tx.$queryRawUnsafe<
        {
          key: string;
          normalizedRootEmail: string;
          rootUserId: string;
          policyId: string;
        }[]
      >(`SELECT key, "normalizedRootEmail", "rootUserId", "policyId"
         FROM "AccessControlBootstrap" WHERE key = $1 FOR UPDATE`, BOOTSTRAP_KEY);

      const root = await locateRoot(tx, normalizedRootEmail);

      if (singleton) {
        // Singleton PRESENT: a changed normalized root is conflicting drift.
        // The attachment is never transferred and no second root attachment is
        // created, however valid the newly configured root may be — the failure
        // is caused by the recorded provenance disagreeing, not by anything
        // wrong with the new candidate.
        if (singleton.normalizedRootEmail !== normalizedRootEmail) {
          fail(
            `conflicting bootstrap drift: the recorded root is "${singleton.normalizedRootEmail}" but ` +
              `ROOT_WORK_EMAIL is now "${normalizedRootEmail}". The bootstrap never transfers the root ` +
              `attachment and never creates a second one. Restore the recorded value, or retire this ` +
              `bootstrap deliberately. Nothing was written.`,
          );
        }
        if (singleton.rootUserId !== root.id) {
          fail(
            `conflicting bootstrap drift: the recorded root User is ${singleton.rootUserId} but ` +
              `"${normalizedRootEmail}" now resolves to ${root.id}. Nothing was written.`,
          );
        }
      }

      let policy = await findFrPolicy(tx);
      if (policy) {
        // Adoption is CONDITIONAL on verification. Adopting by natural key alone
        // would inherit whatever the row happens to say.
        assertCanonicalPolicyShape(policy);
      } else {
        const id = uuidv7();
        await tx.$executeRawUnsafe(
          `INSERT INTO "Policies" (id, operator, "targetType", "targetId", "targetRole", type, "managedBy")
           VALUES ($1, '==', NULL, NULL, $2, 'FR', 'admin')`,
          id,
          FR_ROLE,
        );
        policy = {
          id,
          operator: '==',
          managedBy: 'admin',
          targetType: null,
          targetId: null,
        };
      }

      if (singleton && singleton.policyId !== policy.id) {
        fail(
          `conflicting bootstrap drift: the recorded policy is ${singleton.policyId} but the canonical FR ` +
            `"${FR_ROLE}" policy is ${policy.id}. Nothing was written.`,
        );
      }

      const permissionIds = await ensurePermissions(tx);
      await ensureGrants(tx, policy.id, permissionIds);

      // With NO singleton, an existing attachment is adopted only when it
      // already belongs to the located root. Attachments belonging to anyone
      // else stay non-bootstrap administrator state: rewriting one to point at
      // the configured root would silently revoke a real person's access.
      if (!(await attachmentExists(tx, root.id, policy.id))) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "UserPolicies" ("userId", "policyId") VALUES ($1, $2)`,
          root.id,
          policy.id,
        );
      }

      if (!singleton) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "AccessControlBootstrap" (key, "normalizedRootEmail", "rootUserId", "policyId")
           VALUES ($1, $2, $3, $4)`,
          BOOTSTRAP_KEY,
          normalizedRootEmail,
          root.id,
          policy.id,
        );
      }

      // Revalidate before commit. Everything between the first check and commit
      // is a window in which the root identity can change underneath a
      // transaction that is about to grant it three permissions.
      const stillEligible = await tx.user.findUnique({
        where: { id: root.id },
        select: { workEmail: true, isActive: true },
      });
      if (
        !stillEligible ||
        !stillEligible.isActive ||
        normalizeWorkEmail(stillEligible.workEmail) !== normalizedRootEmail
      ) {
        fail(
          `root identity ${root.id} is no longer eligible at commit time. Rolled back; nothing was written.`,
        );
      }
    },
    { timeout: lockTimeoutMs() + 60_000, maxWait: lockTimeoutMs() + 10_000 },
  );
}

export function createBootstrapPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
}
