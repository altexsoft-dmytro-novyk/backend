// PLAT-E4-S4.2d — the dev seed spine.
//
// Seeds a `type='direct'` reporting spine, two levels deep, over whatever
// active population already exists: for each department, its current active
// members are ordered ascending by `User.id` (uuidv7, time-ordered — this
// reconstructs the population import's own row order); the first becomes the
// department's synthesized lead and gets a `direct` edge straight to root;
// every other active member of that department gets a `direct` edge to that
// lead. A department with zero active members is skipped entirely.
//
// Idempotent, additive-only: a rerun creates an edge only for a user (lead or
// ordinary member) who does not already hold a `direct` `Relationship` row —
// an existing edge, however it got there, is never overwritten, moved, or
// deleted (same philosophy as `access-control-bootstrap.ts`'s `ensureGrants`).
//
// Direct, transactional Prisma writes — the same idiom `dev-grant-root.ts` and
// `access-control-bootstrap.ts` already use for their own tables — bypassing
// `AssignManagerAction`/`OrgRelationshipService`. No `AccessJournal` row is
// written for a seeded edge (spec-4-2d Ask First AF-3): this is fake dev data,
// not an administrator action.
//
// Run AFTER `npm run db:seed`, `npm run db:bootstrap:access-control`, AND
// `npm run db:import:population` — this script reads `DepartmentMembership`
// rows, which only the import creates. Run it whenever an org chart is
// wanted; rerun freely, it is additive-only.
//   npm run db:dev:seed-org
//
// CORRECTED 2026-09-07 (PO, after a Stage-3 code review): this was briefly
// wired as a third step of `create:root`, which runs BEFORE import — so it
// always found zero memberships and silently logged "nothing to seed."
// `create:root` is back to `db:seed && db:bootstrap:access-control` only.
// This script is a standalone manual step now.
//
// SUPERSEDES `scripts/dev-grant-root.ts` (deleted by this same increment) for
// the reporting-spine half of that file's aspirational header comment — the
// permission-grant half is already covered in full by a clean
// `db:seed && db:bootstrap:access-control` (spec-4-2d Code Map).
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const normalizeWorkEmail = (workEmail: string) =>
  workEmail.trim().toLowerCase();

async function main(): Promise<void> {
  // The guard is the first statement `main()` executes — no `DATABASE_URL`/
  // `PrismaClient` construction happens before it (spec-4-2d Boundaries,
  // "Always"). This is a dev-only convenience script; it must never run
  // against production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'dev-seed-org: refusing to run under NODE_ENV=production. This script ' +
        'seeds a fake dev/demo reporting spine and must never run against a ' +
        'production database.',
    );
  }

  const configuredRootEmail = process.env.ROOT_WORK_EMAIL;
  if (!configuredRootEmail || configuredRootEmail.trim() === '') {
    throw new Error(
      'dev-seed-org: ROOT_WORK_EMAIL is blank or unset. Set it and run `npm run db:seed` first.',
    );
  }
  const normalizedRootEmail = normalizeWorkEmail(configuredRootEmail);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error('dev-seed-org: DATABASE_URL is blank or unset.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const everyone = await prisma.user.findMany({
      select: { id: true, workEmail: true, isActive: true },
    });
    const matches = everyone.filter(
      (u) => normalizeWorkEmail(u.workEmail) === normalizedRootEmail,
    );
    if (matches.length !== 1) {
      throw new Error(
        `dev-seed-org: expected exactly one User matching "${normalizedRootEmail}", found ${matches.length}. Run \`npm run db:seed\` first.`,
      );
    }
    const root = matches[0];
    if (!root.isActive) {
      throw new Error(
        `dev-seed-org: root User ${root.id} is inactive. Reactivate it before seeding.`,
      );
    }

    // Every current (`validTo: null`) membership, across the whole
    // population — a user CAN hold more than one concurrently
    // (`DepartmentMembership`'s unique constraint is per-department, not
    // per-user; spec-4-2d Ask First AF-5).
    const currentMemberships = await prisma.departmentMembership.findMany({
      where: { validTo: null },
      select: { userId: true, departmentId: true },
    });

    // AF-5 tie-break: a user with more than one concurrent membership is
    // treated as belonging only to the membership whose `departmentId` is
    // lexicographically smallest, for spine purposes.
    const departmentIdsByUser = new Map<string, string[]>();
    for (const { userId, departmentId } of currentMemberships) {
      const list = departmentIdsByUser.get(userId) ?? [];
      list.push(departmentId);
      departmentIdsByUser.set(userId, list);
    }
    const owningDepartmentByUser = new Map<string, string>();
    for (const [userId, departmentIds] of departmentIdsByUser) {
      owningDepartmentByUser.set(userId, [...departmentIds].sort()[0]);
    }

    // Only active users receive an edge — a department all of whose current
    // members are inactive is skipped entirely, with no error.
    const activeMembers = await prisma.user.findMany({
      where: {
        id: { in: [...owningDepartmentByUser.keys()] },
        isActive: true,
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    // Each department's active roster, in ascending `User.id` order — the
    // department's own lead-synthesis order (spec Design Notes). Iterating
    // `activeMembers` (already sorted ascending) and pushing preserves that
    // order per department without a second sort.
    const rosterByDepartment = new Map<string, string[]>();
    for (const { id: userId } of activeMembers) {
      const departmentId = owningDepartmentByUser.get(userId);
      if (!departmentId) continue;
      const roster = rosterByDepartment.get(departmentId) ?? [];
      roster.push(userId);
      rosterByDepartment.set(departmentId, roster);
    }

    // Idempotence: never create an edge for a user (lead or member) who
    // already holds one of type `direct`, regardless of who wrote it or
    // where it points.
    const existingDirectHolders = await prisma.relationship.findMany({
      where: { type: 'direct' },
      select: { userId: true },
    });
    const alreadyHasDirect = new Set(
      existingDirectHolders.map((row) => row.userId),
    );

    interface PendingEdge {
      userId: string;
      reportsToUserId: string;
    }
    const pendingEdges: PendingEdge[] = [];

    for (const roster of rosterByDepartment.values()) {
      if (roster.length === 0) continue;
      const [leadId, ...otherMemberIds] = roster;
      if (!alreadyHasDirect.has(leadId)) {
        pendingEdges.push({ userId: leadId, reportsToUserId: root.id });
      }
      for (const memberId of otherMemberIds) {
        if (!alreadyHasDirect.has(memberId)) {
          pendingEdges.push({ userId: memberId, reportsToUserId: leadId });
        }
      }
    }

    if (pendingEdges.length === 0) {
      console.log(
        'dev-seed-org: nothing to seed — zero departments with an active ' +
          'member lacking a direct relationship row.',
      );
      return;
    }

    await prisma.$transaction(
      pendingEdges.map(({ userId, reportsToUserId }) =>
        prisma.relationship.create({
          data: { userId, type: 'direct', reportsToUserId },
        }),
      ),
    );

    console.log(
      `dev-seed-org: created ${pendingEdges.length} direct relationship ` +
        `row(s) across ${rosterByDepartment.size} department(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('dev-seed-org failed:', error);
  process.exitCode = 1;
});
