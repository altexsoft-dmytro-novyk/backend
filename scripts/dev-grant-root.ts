// INTERIM root-operator bootstrap. Grants the seeded root `User` an `hr-admin`
// functional-role policy carrying the permission keys the app's `@RequireFeature`
// / in-action `isAllowed` gates check — so whoever signs in as root can actually
// operate: run the population import, fix its mistakes, wire managers/PPs, record
// departures. Usable in dev AND as a production deploy stopgap (no `NODE_ENV`
// guard — decision, Dmytro 2026-09-04).
//
// SUPERSEDED BY Platform Epic 4 Story 4.2
// (`_bmad-output/implementation-artifacts/platform/story-4-2-default-org-relationship-seed.md`):
// 4.2 folds the real operator permission set into the canonical
// `bootstrap-access-control.ts` (an AD-1 amendment to the ACM-1 canonical set),
// seats root at the reporting-tree root, and makes it the §2.4 first holder — so
// a clean `db:seed && db:bootstrap:access-control` leaves root fully operational
// with no extra script. Delete this file when 4.2 lands.
//
// KNOWN DEBT while this stands: it writes a permission bundle wider than the
// ACM-1 canonical three keys and uses the pre-`directory:*` key names, so a run
// followed by the ACM-1 drift-check e2e (`acm1r-fr-foundation.e2e-spec.ts`, which
// asserts EXACTLY `user-management:create`/`:deactivate`/`:list`) will fail that
// suite — run it against a dedicated DB. The FR policy IS created in the shape
// the bootstrap asserts (operator `==`, `managedBy: 'admin'`, no target), so
// `bootstrap-access-control.ts` itself still coexists.
//
// Run AFTER `npm run db:seed` (and, if you use it, `db:bootstrap:access-control`):
//   npm run db:dev:grant-root
//
// Idempotent: every row is reused when present.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const ROOT_FR_ROLE = 'hr-admin';

// Kept in sync with the `RequireFeature(...)` / `isAllowed(...)` call sites in
// `src/user-management`. `user-management:read` is intentionally absent: the
// §3.2 S1 (profile:identity) read gate is a pure audience/section decision with
// no FR half.
//
// `user-management:edit` is still granted here, but AS OF PLAT-E4-S4.1c IT NO
// LONGER GRANTS ANYTHING. That story moved `PATCH /users/:id` and the `canEdit`
// hint onto `@RequireSectionAccess('profile:identity', 'write')`, whose
// functional half is `profile:identity:write`, and 4.1d deleted the last of the
// old machinery. The gate is audience-first, so no functional grant can widen a
// resolved audience (`docs/architecture/access-control.md:19`, NORMATIVE):
// root now gets `canEdit: false` on any card it has no reporting-line or
// People-Partner edge to. Removing the key from this list is Story 4.2's, coupled
// to seating root in the reporting tree — until then it is an inert grant.
const ROOT_PERMISSIONS: ReadonlyArray<{ key: string; description: string }> = [
  {
    key: 'user-management:create',
    description: 'Create/import users in User Management.',
  },
  {
    key: 'user-management:edit',
    description: 'Edit any employee identity card (S1), including own.',
  },
  {
    key: 'user-management:list',
    description: 'List users in User Management.',
  },
  {
    key: 'user-management:deactivate',
    description: 'Deactivate a user in User Management.',
  },
  {
    key: 'org:relationships:write',
    description: 'Write organisational relationships and department edges.',
  },
  {
    key: 'employee:departure:record',
    description: 'Record and remediate an employee departure.',
  },
  {
    key: 'profile:timeline:write',
    description: 'Add or soft-delete career-timeline events.',
  },
];

const normalizeWorkEmail = (workEmail: string) =>
  workEmail.trim().toLowerCase();

async function main(): Promise<void> {
  const configuredRootEmail = process.env.ROOT_WORK_EMAIL;
  if (!configuredRootEmail || configuredRootEmail.trim() === '') {
    throw new Error(
      'dev-grant-root: ROOT_WORK_EMAIL is blank or unset. Set it and run `npm run db:seed` first.',
    );
  }
  const normalizedRootEmail = normalizeWorkEmail(configuredRootEmail);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error('dev-grant-root: DATABASE_URL is blank or unset.');
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
        `dev-grant-root: expected exactly one User matching "${normalizedRootEmail}", found ${matches.length}. Run \`npm run db:seed\` first.`,
      );
    }
    const root = matches[0];
    if (!root.isActive) {
      throw new Error(
        `dev-grant-root: root User ${root.id} is inactive. Reactivate it before granting.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      const permissionIds: string[] = [];
      for (const { key, description } of ROOT_PERMISSIONS) {
        const existing = await tx.permission.findUnique({ where: { key } });
        permissionIds.push(
          existing?.id ??
            (await tx.permission.create({ data: { key, description } })).id,
        );
      }

      const policy =
        (await tx.policy.findFirst({
          where: { type: 'FR', targetRole: ROOT_FR_ROLE },
        })) ??
        (await tx.policy.create({
          data: {
            operator: '==',
            targetType: null,
            targetId: null,
            targetRole: ROOT_FR_ROLE,
            type: 'FR',
            managedBy: 'admin',
          },
        }));

      await tx.policyPermission.createMany({
        data: permissionIds.map((permissionId) => ({
          policyId: policy.id,
          permissionId,
          policyType: 'FR',
        })),
        skipDuplicates: true,
      });

      await tx.userPolicy.upsert({
        where: { userId_policyId: { userId: root.id, policyId: policy.id } },
        create: { userId: root.id, policyId: policy.id },
        update: {},
      });

      console.log(
        `dev-grant-root: root ${root.id} now holds FR policy ${policy.id} ` +
          `with ${ROOT_PERMISSIONS.length} permissions ` +
          `(${ROOT_PERMISSIONS.map((p) => p.key).join(', ')}).`,
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('dev-grant-root failed:', error);
  process.exitCode = 1;
});
