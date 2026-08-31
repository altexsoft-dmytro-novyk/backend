// Deploy-time wrapper for the ACM-1 Access Control bootstrap.
//
// Runs as `npm run db:bootstrap:access-control`, after `npm run db:seed` and
// before `start:prod`. Exits nonzero on any failure so a deployment cannot
// proceed with a half-provisioned functional role.
import 'dotenv/config';
import {
  bootstrapAccessControl,
  createBootstrapPrismaClient,
} from '../src/access-control/infrastructure/bootstrap/access-control-bootstrap';

async function main(): Promise<void> {
  const prisma = createBootstrapPrismaClient();
  try {
    await bootstrapAccessControl(prisma);
    console.log(
      'Access Control bootstrap: canonical functional-role state is in place.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
