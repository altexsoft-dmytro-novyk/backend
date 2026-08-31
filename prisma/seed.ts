// Bootstraps the very first `User` row so the app has at least one account
// to sign in with. This is NOT the registration endpoint's code path — no
// magic-link is dispatched, no session/access-control port is touched — and
// it deliberately does not assign the HR Admin functional role: the separate
// ACM-1 Access Control bootstrap entrypoint owns FR policy, grant, and
// attachment setup after this root User prerequisite has succeeded.
//
// Only pseudonymised data belongs here — never real personal data
// (epic-1-context.md).
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { uuidv7 } from 'uuidv7';
import { Prisma, PrismaClient } from '../src/generated/prisma/client';

const ROOT_WORK_EMAIL = process.env.ROOT_WORK_EMAIL;

type RootCandidate = {
  id: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  isActive: boolean;
  position: string;
};

const normalizeWorkEmail = (workEmail: string) =>
  workEmail.trim().toLowerCase();

const rootFailure = (message: string) => new Error(`Seed: ${message}`);

async function findNormalizedRootMatches(
  prisma: PrismaClient,
  normalizedRootEmail: string,
): Promise<{ candidates: RootCandidate[]; matches: RootCandidate[] }> {
  const candidates = await prisma.user.findMany({
    select: {
      id: true,
      firstName: true,
      lastName: true,
      workEmail: true,
      isActive: true,
      position: true,
    },
  });

  return {
    candidates,
    matches: candidates.filter(
      (candidate) =>
        normalizeWorkEmail(candidate.workEmail) === normalizedRootEmail,
    ),
  };
}

function validateRootEligibility(
  normalizedRootEmail: string,
  matches: RootCandidate[],
): RootCandidate {
  if (matches.length === 0) {
    throw rootFailure(
      `unmatched root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" has 0 matches. Correct the configured root identity before retrying.`,
    );
  }

  if (matches.length !== 1) {
    const conflicts = matches
      .map(({ id, isActive }) => `${id} (isActive=${isActive})`)
      .join(', ');
    throw rootFailure(
      `ambiguous root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" has ${matches.length} matches: ${conflicts}. Reconcile duplicate normalized workEmail values before retrying.`,
    );
  }

  const [root] = matches;
  if (!root.isActive) {
    throw rootFailure(
      `inactive root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" matched User ${root.id} with isActive=false. Automatic reactivation is prohibited; reactivate the intended User through its approved lifecycle flow before retrying.`,
    );
  }

  return root;
}

function isUniqueWorkEmailViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    }),
  });

  try {
    const normalizedRootEmail = normalizeWorkEmail(ROOT_WORK_EMAIL ?? '');
    if (!normalizedRootEmail) {
      throw rootFailure(
        'ROOT_WORK_EMAIL is blank after trimming. Configure a nonblank work email before running db:seed.',
      );
    }

    let { candidates, matches } = await findNormalizedRootMatches(
      prisma,
      normalizedRootEmail,
    );

    if (matches.length === 0) {
      const conflictingHrAdmin = candidates.find(
        (candidate) =>
          candidate.position === 'HR Admin' &&
          (candidate.firstName !== 'Root' || candidate.lastName !== 'Admin'),
      );
      if (conflictingHrAdmin) {
        throw rootFailure(
          `unmatched root identity: normalized ROOT_WORK_EMAIL "${normalizedRootEmail}" has 0 matches and existing HR Admin User ${conflictingHrAdmin.id} is not a fallback. Correct the configured root identity before retrying.`,
        );
      }

      // `createdBy` is a required, non-nullable FK to `User` — the very first
      // row has no other user to point at, so it self-references. The id is
      // generated up front (rather than left to Prisma's schema default) so
      // it can be reused as its own `createdBy` in the same insert.
      const rootId = uuidv7();
      try {
        const root = await prisma.user.create({
          data: {
            id: rootId,
            firstName: 'Root',
            lastName: 'Admin',
            position: 'HR Admin',
            country: '',
            city: '',
            workEmail: normalizedRootEmail,
            companyJoinDate: new Date('1970-01-01'),
            createdBy: rootId,
          },
        });

        console.log(
          `Seed: created bootstrap user ${root.id} (${root.workEmail}).`,
        );
      } catch (error) {
        if (!isUniqueWorkEmailViolation(error)) {
          throw error;
        }

        console.log(
          `Seed: users_workEmail_key conflict for "${normalizedRootEmail}"; re-reading root identity.`,
        );
      }

      ({ candidates, matches } = await findNormalizedRootMatches(
        prisma,
        normalizedRootEmail,
      ));
    }

    const root = validateRootEligibility(normalizedRootEmail, matches);
    console.log(
      `Seed: validated bootstrap user ${root.id} (${root.workEmail}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
