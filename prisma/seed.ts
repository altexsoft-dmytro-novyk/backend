// Bootstraps the very first `User` row so the app has at least one account
// to sign in with. This is NOT the registration endpoint's code path — no
// magic-link is dispatched, no session/access-control port is touched — and
// it deliberately does not assign the HR Admin functional role: `Policies`/
// `UserPolicies` don't exist yet (epic-1-context.md Requirements &
// Constraints; that bootstrap-role behavior has its own acceptance test
// elsewhere, out of this story's scope).
//
// Only pseudonymised data belongs here — never real personal data
// (epic-1-context.md).
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../src/generated/prisma/client';

const ROOT_WORK_EMAIL = process.env.ROOT_WORK_EMAIL;

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    }),
  });

  try {
    if (!ROOT_WORK_EMAIL) {
      console.warn('Root user email address was not provided! Skipping user creation');

      return;
    }

    const existing = await prisma.user.findUnique({
      where: { workEmail: ROOT_WORK_EMAIL },
    });
    if (existing) {
      console.log(`Seed: "${ROOT_WORK_EMAIL}" already exists, skipping.`);
      return;
    }

    // `createdBy` is a required, non-nullable FK to `User` — the very first
    // row has no other user to point at, so it self-references. The id is
    // generated up front (rather than left to Prisma's schema default) so
    // it can be reused as its own `createdBy` in the same insert.
    const rootId = uuidv7();
    const root = await prisma.user.create({
      data: {
        id: rootId,
        firstName: 'Root',
        lastName: 'Admin',
        position: 'HR Admin',
        country: '',
        city: '',
        workEmail: ROOT_WORK_EMAIL,
        companyJoinDate: new Date('1970-01-01'),
        createdBy: rootId,
      },
    });

    console.log(`Seed: created bootstrap user ${root.id} (${root.workEmail}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
