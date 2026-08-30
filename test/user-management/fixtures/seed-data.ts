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
export async function ensureHrAdminPolicy(
  prisma: PrismaService,
): Promise<{ id: string }> {
  const policy = await prisma.policy.upsert({
    where: { name: 'HR Admin' },
    update: {},
    create: { name: 'HR Admin' },
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
    await prisma.userEvents.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.magicLinkToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.userPolicy.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.department.deleteMany({ where: { name: { contains: runId } } });
}
