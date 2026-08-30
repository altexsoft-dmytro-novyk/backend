import { PrismaService } from '../../../src/prisma/prisma.service';

// Low-level Prisma fixture primitives for the seed/ and auth/ E2E suites.
// Test-data isolation (testing-strategy.md, DEC-UM-010): one worker, a
// collision-proof UUID/email namespace per run (`runId`), each run deletes
// only the rows it created (see cleanupRun below) — same convention as
// test/access-control/fixtures/graph.ts.

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

export function newRunId(prefix: string): string {
  return `um-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SeededUser {
  id: string;
  workEmail: string;
  firstName: string;
  lastName: string;
  position: string;
  country: string;
  city: string;
  workPhone: string | null;
  birthDay: number | null;
  birthMonth: number | null;
  companyJoinDate: Date;
  ttId: string | null;
  isActive: boolean;
}

export async function createDepartment(
  prisma: PrismaService,
  runId: string,
  overrides: {
    name?: string;
    isHrDepartment?: boolean;
    parentId?: string;
    managerId?: string;
  } = {},
): Promise<{ id: string }> {
  const dept = await prisma.department.create({
    data: {
      name: overrides.name ?? `${runId}-dept-${nextSeq()}`,
      isHrDepartment: overrides.isHrDepartment ?? false,
      parentId: overrides.parentId,
      managerId: overrides.managerId,
    },
  });
  return { id: dept.id };
}

/**
 * Inserts a User row shaped exactly like the population-import script
 * (Story 1.1 / um-seed-01) is expected to produce for one seeded employee —
 * every S1 identity-card field the scenario asserts against. The real
 * import script (prisma/seed.ts + its data source) is out of this task's
 * scope to build (services/backend/prisma/** is off-limits here); this
 * fixture stands in for its row-level output so the seed/auth suites can
 * exercise the real read/auth endpoints, per
 * .claude/rules/nest-e2e.md's "closest real substitute" guidance for a
 * precondition with no HTTP-observable seam (there is no POST /users to
 * create these through — that path is retired, AD-25).
 */
export async function createSeededUser(
  prisma: PrismaService,
  runId: string,
  persona: string,
  departmentId: string,
  overrides: Record<string, unknown> = {},
): Promise<SeededUser> {
  const workEmail = `${runId}-${persona.toLowerCase()}@company.example`;
  const user = await prisma.user.create({
    data: {
      firstName: persona,
      lastName: 'Seeded',
      position: 'Engineer',
      country: 'Poland',
      city: 'Warsaw',
      workEmail,
      workPhone: '+48-000-000-000',
      birthDay: 15,
      birthMonth: 6,
      companyJoinDate: new Date('2024-01-01'),
      ttId: `${runId}-tt-${nextSeq()}`,
      departmentId,
      ...overrides,
    },
  });
  return user;
}

// AD-5: real reports-to / people-partner edges, needed once the
// profile/career-timeline/list suites started exercising real
// AccessControl-gated routes (Bob as Alice's manager, Paula as her PP) —
// same shape as test/access-control/fixtures/graph.ts's equivalents.
export async function createDirectEdge(
  prisma: PrismaService,
  subjectUserId: string,
  holderUserId: string,
): Promise<{ id: string }> {
  const rel = await prisma.relationship.create({
    data: { type: 'direct', subjectUserId, holderUserId },
  });
  return { id: rel.id };
}

export async function createPPEdge(
  prisma: PrismaService,
  subjectUserId: string,
  holderUserId: string,
): Promise<{ id: string }> {
  const rel = await prisma.relationship.create({
    data: { type: 'people_partner', subjectUserId, holderUserId },
  });
  return { id: rel.id };
}

export async function writeJoinedCompanyEvent(
  prisma: PrismaService,
  userId: string,
  eventDate: Date,
  createdBy: string,
): Promise<{ id: string }> {
  const event = await prisma.userEvents.create({
    data: {
      userId,
      type: 'joined_company',
      source: 'system',
      eventDate,
      details: {},
      createdBy,
    },
  });
  return { id: event.id };
}

/**
 * Closest real substitute for "Colin's departure effective date has passed
 * and the executor has applied it" (um-list-05's precondition) — Epic 5's
 * Departure-record + AD-16 scheduled executor are a different epic, out of
 * this task's scope to build. This writes the materialized outcome the
 * executor would have produced (an open, dismissed EmploymentStatus row)
 * directly, per nest-e2e.md's "closest real substitute" guidance, so
 * um-list-05 can exercise the real GET /users default-exclusion/filter
 * logic without re-deriving Epic 5's own machinery.
 */
export async function markDismissed(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  await prisma.employmentStatus.create({
    data: {
      userId,
      status: 'dismissed',
      startDate: new Date(),
    },
  });
}

export async function deactivateUser(
  prisma: PrismaService,
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { isActive: false },
  });
}

/**
 * Idempotent — same convention as access-control fixtures' ensurePermission
 * (AD-9: this is a shared catalog row, "HR Admin" is a real, singular
 * functional role name in production, not a run-scoped fixture value, so it
 * is upserted rather than created fresh per run). Callers are responsible
 * for cleaning up only the UserPolicy attachment they create (cleanupRun
 * below does this), never the Policy row itself.
 */
/**
 * Also idempotently attaches the `manage_roles` permission (AD-9 closed
 * catalog — same permission prisma/seed.ts's real HR Admin bootstrap
 * seeds), so a session established for a policy holder created through
 * this fixture can actually pass RolesController's `isAllowed(actorId,
 * 'manage_roles')` gate on `GET /roles` — without it, um-seed-03's own
 * assertion (root reading the role catalog) would 403 before it ever got
 * to check holderCount.
 */
export async function ensureHrAdminPolicy(
  prisma: PrismaService,
): Promise<{ id: string }> {
  const policy = await prisma.policy.upsert({
    where: { name: 'HR Admin' },
    update: {},
    create: { name: 'HR Admin' },
  });
  const permission = await prisma.permission.upsert({
    where: { name: 'manage_roles' },
    update: {},
    create: { name: 'manage_roles' },
  });
  await prisma.policyPermission.upsert({
    where: {
      policyId_permissionId: {
        policyId: policy.id,
        permissionId: permission.id,
      },
    },
    update: {},
    create: { policyId: policy.id, permissionId: permission.id },
  });
  return { id: policy.id };
}

export async function attachPolicyToUser(
  prisma: PrismaService,
  userId: string,
  policyId: string,
): Promise<void> {
  await prisma.userPolicy.create({ data: { userId, policyId } });
}

/**
 * Detaches one policy attachment early (before the file's own afterAll
 * cleanup) — needed when a scenario attaches a fixture user to the shared,
 * name-idempotent 'HR Admin' policy (ensureHrAdminPolicy) purely to pass an
 * unrelated permission gate, and a *later* scenario in the same file
 * counts that policy's holders. Without this, holder counts silently
 * accumulate across describe blocks within one file run.
 */
export async function detachPolicyFromUser(
  prisma: PrismaService,
  userId: string,
  policyId: string,
): Promise<void> {
  await prisma.userPolicy.delete({
    where: { userId_policyId: { userId, policyId } },
  });
}

/**
 * Deletes exactly the rows this run created, in FK-safe order (children
 * before parents) — same shape as test/access-control/fixtures/graph.ts's
 * cleanupRun, scoped to the tables the seed/auth suites can populate. The
 * shared "HR Admin" Policy row is deliberately NOT deleted here (see
 * ensureHrAdminPolicy) — only this run's UserPolicy attachment to it.
 */
export async function cleanupRun(
  prisma: PrismaService,
  runId: string,
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { workEmail: { contains: runId } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  if (userIds.length > 0) {
    // Relationship/RelationshipJournal rows must go before the users they
    // reference — User's FK to Relationship is RESTRICT, same ordering
    // concern test/access-control/fixtures/graph.ts's cleanupRun documents.
    await prisma.relationship.deleteMany({
      where: {
        OR: [
          { subjectUserId: { in: userIds } },
          { holderUserId: { in: userIds } },
        ],
      },
    });
    await prisma.relationshipJournal.deleteMany({
      where: { subjectUserId: { in: userIds } },
    });
    await prisma.departure.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.employmentStatus.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.userEvents.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.sectionRecord.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.magicLinkToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.userPolicy.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.department.deleteMany({ where: { name: { contains: runId } } });
}
