import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.service';

// Shared low-level fixture primitives for the access-control E2E suite.
// Story 1 (population seed/import) has not landed yet, so every persona row
// this suite needs is inserted directly via Prisma rather than through
// POST /users (which does not exist yet either — access-control's own
// suite tests the facade in front of routes user-management hasn't built).
//
// Test-data isolation (testing-strategy.md, DEC-UM-010): one worker, a
// collision-proof UUID/email namespace per run (`runId`), each run deletes
// only the rows it created (see cleanupRun below).

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

export function newRunId(prefix: string): string {
  return `ac-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function bootstrapApp(): Promise<{
  app: INestApplication<App>;
  prisma: PrismaService;
}> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app: INestApplication<App> = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  return { app, prisma };
}

export interface FixtureUser {
  id: string;
  workEmail: string;
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

export async function createUser(
  prisma: PrismaService,
  runId: string,
  persona: string,
  departmentId: string,
  overrides: Record<string, unknown> = {},
): Promise<FixtureUser> {
  const workEmail = `${runId}-${persona.toLowerCase()}@company.example`;
  const user = await prisma.user.create({
    data: {
      firstName: persona,
      lastName: 'Fixture',
      position: 'Engineer',
      country: 'Poland',
      city: 'Warsaw',
      workEmail,
      companyJoinDate: new Date('2024-01-01'),
      departmentId,
      ...overrides,
    },
  });
  return { id: user.id, workEmail: user.workEmail };
}

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

export async function createProject(
  prisma: PrismaService,
  runId: string,
  name?: string,
): Promise<{ id: string }> {
  const project = await prisma.project.create({
    data: { name: name ?? `${runId}-project-${nextSeq()}` },
  });
  return { id: project.id };
}

export async function assignToProject(
  prisma: PrismaService,
  projectId: string,
  userId: string,
): Promise<{ id: string }> {
  const assignment = await prisma.projectAssignment.create({
    data: { projectId, userId },
  });
  return { id: assignment.id };
}

export async function createDeparture(
  prisma: PrismaService,
  userId: string,
  effectiveDate: Date,
  recordedBy: string,
): Promise<{ id: string }> {
  const departure = await prisma.departure.create({
    data: { userId, effectiveDate, reason: 'fixture departure', recordedBy },
  });
  return { id: departure.id };
}

/** Idempotent — Permission is a closed, name-unique catalog (AD-9). */
export async function ensurePermission(
  prisma: PrismaService,
  name: string,
): Promise<{ id: string }> {
  const permission = await prisma.permission.upsert({
    where: { name },
    update: {},
    create: { name },
  });
  return { id: permission.id };
}

export async function createPolicy(
  prisma: PrismaService,
  runId: string,
  name: string,
): Promise<{ id: string }> {
  const policy = await prisma.policy.create({
    data: { name: `${runId}-${name}` },
  });
  return { id: policy.id };
}

export async function attachPermissionToPolicy(
  prisma: PrismaService,
  policyId: string,
  permissionId: string,
): Promise<void> {
  await prisma.policyPermission.create({ data: { policyId, permissionId } });
}

export async function attachPolicyToUser(
  prisma: PrismaService,
  userId: string,
  policyId: string,
): Promise<void> {
  await prisma.userPolicy.create({ data: { userId, policyId } });
}

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
 * Simulates a genuinely orphaned foreign key (a deleted/missing endpoint
 * user behind a relationship edge) for the fail-closed scenarios that
 * explicitly describe this state (AC-AD-08, AC-AD-16, AC-AD-17). The
 * schema's `ON DELETE RESTRICT` constraints (database-schema.md;
 * migration `relationships_holder_user_id_fkey`) block a plain delete of a
 * user still referenced by a Relationship row — by design, that's exactly
 * what stops a normal write path from producing this state. These
 * scenarios need the state to exist anyway (the whole point is proving the
 * resolver fails closed on data that is already broken, e.g. inherited
 * from a bulk import predating a referential-integrity fix), so this
 * helper disables the table's FK triggers for the single delete that
 * breaks the edge and re-enables them immediately after — this produces a
 * real dangling foreign key row in Postgres, not a placeholder standing in
 * for one. Judgment call, documented here and in the audience-derivation
 * suite's top-of-file comment.
 */
export async function deleteUserBreakingReferences(
  prisma: PrismaService,
  _referencingTable: string,
  userId: string,
): Promise<void> {
  // Postgres installs the RESTRICT-enforcing RI trigger on the REFERENCED
  // table (`users`, the DELETE target here), not on the referencing child
  // table — confirmed against pg_trigger. Disabling triggers on the child
  // table (the original `referencingTable` parameter, kept for call-site
  // compatibility but unused) leaves the actual RESTRICT trigger active and
  // the DELETE still fails; disabling `users`' own triggers is what
  // actually bypasses it for this one deliberate hard delete.
  await prisma.$executeRawUnsafe(`ALTER TABLE "users" DISABLE TRIGGER ALL`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE id = $1`, userId);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "users" ENABLE TRIGGER ALL`);
  }
}

/** Same technique as above, for AC-FC-02's hard-deleted project target. */
export async function deleteProjectBreakingReferences(
  prisma: PrismaService,
  projectId: string,
): Promise<void> {
  // Same correction as deleteUserBreakingReferences above: the RESTRICT
  // trigger lives on `projects` (the DELETE target/referenced table), not
  // on the referencing `project_assignments` child table.
  await prisma.$executeRawUnsafe(`ALTER TABLE "projects" DISABLE TRIGGER ALL`);
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "projects" WHERE id = $1`,
      projectId,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "projects" ENABLE TRIGGER ALL`);
  }
}

/**
 * Deletes exactly the rows this run created, in FK-safe order (children
 * before parents). Matches every other e2e suite's `runId`-scoped cleanup
 * convention (see relationships.e2e-spec.ts), extended to every table this
 * suite's fixtures can populate.
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
    // SectionRecord (added after this fixture was authored — see
    // schema.prisma's doc comment) is written by the facade's own S2-S8/
    // S10/S12/S16 routes; every run-scoped user this fixture creates may
    // have rows here by the time cleanup runs.
    await prisma.sectionRecord.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.magicLinkToken.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.projectAssignment.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.userPolicy.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.fullProfileAccessGrant.deleteMany({
      where: { userId: { in: userIds } },
    });
    // Departments this run created may still carry managerId pointing at a
    // user about to be deleted (ON DELETE SET NULL handles that FK) —
    // users must go first regardless, since User.departmentId is RESTRICT.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.department.deleteMany({ where: { name: { contains: runId } } });
  await prisma.project.deleteMany({ where: { name: { contains: runId } } });

  const policies = await prisma.policy.findMany({
    where: { name: { contains: runId } },
    select: { id: true },
  });
  const policyIds = policies.map((p) => p.id);
  if (policyIds.length > 0) {
    await prisma.policyPermission.deleteMany({
      where: { policyId: { in: policyIds } },
    });
    await prisma.userPolicy.deleteMany({
      where: { policyId: { in: policyIds } },
    });
    await prisma.policy.deleteMany({ where: { id: { in: policyIds } } });
  }
}
