// Deploy/operator entrypoint for the Story 1.1 seeded-population import (AD-16).
//
// Runs as `npm run db:import:population`, in the binding deployment order
// `db:deploy` -> `db:seed` (ACM-0 root User) -> `db:bootstrap:access-control`
// (ACM-1) -> **this** -> `start:prod` (api-conventions.md, seed README).
//
// It reads the delivered `docs/Accounts_template.csv` from the known repo path
// and writes through the SAME import service / normalization / idempotent-upsert
// contract as `POST /users/import` (the HTTP endpoint is upload-only and never
// touches a server-local path). Re-runnable: a second run reports every row as
// `updated`, `created: 0`, `departmentsCreated: 0`.
//
// Like `prisma/seed.ts` and `scripts/bootstrap-access-control.ts`, this wires a
// bare `PrismaClient` rather than booting Nest — the import writer
// (`PopulationImportService` + `PopulationImportRepository`) only needs the
// Prisma surface, and the HTTP-transport concerns (guards, session) do not
// apply to a deploy step.
import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { uuidv7 } from 'uuidv7';
import { PrismaClient } from '../src/generated/prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ImportPopulationAction } from '../src/user-management/application/actions/import-population.action';
import { PopulationImportService } from '../src/user-management/domain/services/population-import.service';
import { PopulationImportRepository } from '../src/user-management/infrastructure/population-import.repository';

const POPULATION_CSV_PATH = path.resolve(
  __dirname,
  '../../../docs/Accounts_template.csv',
);

const normalizeWorkEmail = (workEmail: string): string =>
  workEmail.trim().toLowerCase();

/**
 * The ACM-0 root `User` id — the operator the import runs as (`User.createdBy`).
 * Prefers the `AccessControlBootstrap` singleton recorded by ACM-1; falls back
 * to a normalized `ROOT_WORK_EMAIL` match; as a last resort (a deploy that
 * skipped `db:seed`) it provisions the root the same way `prisma/seed.ts` does,
 * so the script is genuinely standalone-runnable.
 */
async function resolveOperatorId(prisma: PrismaClient): Promise<string> {
  const singleton = await prisma.$queryRawUnsafe<Array<{ rootUserId: string }>>(
    `SELECT "rootUserId" FROM "AccessControlBootstrap" WHERE key = 'root-hr-admin'`,
  );
  if (singleton[0]) {
    const exists = await prisma.user.findUnique({
      where: { id: singleton[0].rootUserId },
      select: { id: true },
    });
    if (exists) return exists.id;
  }

  const normalizedRootEmail = normalizeWorkEmail(
    process.env.ROOT_WORK_EMAIL ?? 'root@company.example',
  );
  const everyone = await prisma.user.findMany({
    select: { id: true, workEmail: true },
  });
  const matches = everyone.filter(
    (u) => normalizeWorkEmail(u.workEmail) === normalizedRootEmail,
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous root identity: "${normalizedRootEmail}" has ${matches.length} matches. Run db:seed / reconcile first.`,
    );
  }

  const rootId = uuidv7();
  const created = await prisma.user.create({
    data: {
      id: rootId,
      firstName: 'Root',
      lastName: 'Admin',
      position: 'HR Admin',
      country: '',
      city: null,
      workEmail: normalizedRootEmail,
      companyJoinDate: new Date('1970-01-01'),
      createdBy: rootId,
    },
  });
  console.log(
    `import-population: no ACM-0 root found; provisioned ${created.id} (${created.workEmail}).`,
  );
  return created.id;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const repository = new PopulationImportRepository(
      prisma as unknown as PrismaService,
    );
    const action = new ImportPopulationAction(
      new PopulationImportService(repository),
    );

    const operatorId = await resolveOperatorId(prisma);
    const file = fs.readFileSync(POPULATION_CSV_PATH);
    const summary = await action.execute(file, operatorId);

    console.log(
      `import-population: ${JSON.stringify(summary)} (source ${POPULATION_CSV_PATH})`,
    );
    if (summary.errors.length > 0) {
      console.warn(
        `import-population: ${summary.skipped} row(s) skipped — see errors above.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'import-population failed:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
