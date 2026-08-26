import { Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  Session,
  SessionResolverPort,
} from '../domain/interfaces/session-resolver.port';

const BEARER_PERSONA_TOKEN = /^Bearer <token:(?<persona>[^>]+)>$/;
const INTERIM_ROOT_EMAIL_PREFIX = 'interim-root-';

// TEMPORARY (2026-08-26 renegotiation, see spec-1-1's Boundaries & Constraints):
// stands in for real session issuance/lookup until Epic 2 ships. The real
// call this replaces:
//   const session = await this.sessionStore.resolve(authorizationHeader);
// Recognizes the `Bearer <token:persona>` fixture convention used across
// every e2e suite in this repo (docs/test-cases/README.md). The "Root"
// persona resolves to whichever seeded `User` row holds `position: 'HR
// Admin'` — preferring a real one (a file's own bootstrap fixture, or the
// real seed script's root user) over a lazily self-provisioned stand-in, so
// a file that sets up its own bootstrap (registration.e2e-spec.ts) always
// gets that exact row back, while a file with no bootstrap of its own
// (profile.e2e-spec.ts) still gets a valid `createdBy` FK target instead of
// 404ing on every request. Any other persona has no interim resolution and
// falls through to the access-control adapter's deny-by-default.
@Injectable()
export class InterimSessionResolverAdapter implements SessionResolverPort {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    authorizationHeader: string | undefined,
  ): Promise<Session | null> {
    if (!authorizationHeader) {
      return null;
    }

    const match = BEARER_PERSONA_TOKEN.exec(authorizationHeader);
    const persona = match?.groups?.persona;
    if (!persona) {
      return null;
    }

    if (persona === 'Root') {
      const hrAdmin = await this.resolveOrProvisionRoot();
      return { userId: hrAdmin.id };
    }

    return { userId: persona };
  }

  private async resolveOrProvisionRoot(): Promise<{ id: string }> {
    // Most-recent first: a leftover row from an earlier crashed/aborted
    // run (whose own cleanup never ran) must never shadow the current
    // run's own fresh bootstrap fixture.
    const realHrAdmin = await this.prisma.user.findFirst({
      where: {
        position: 'HR Admin',
        workEmail: { not: { startsWith: INTERIM_ROOT_EMAIL_PREFIX } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (realHrAdmin) {
      return realHrAdmin;
    }

    const anyInterimRoot = await this.prisma.user.findFirst({
      where: { workEmail: { startsWith: INTERIM_ROOT_EMAIL_PREFIX } },
      orderBy: { createdAt: 'desc' },
    });
    if (anyInterimRoot) {
      return anyInterimRoot;
    }

    const id = uuidv7();
    return this.prisma.user.create({
      data: {
        id,
        firstName: 'Root',
        lastName: 'Admin',
        position: 'HR Admin',
        country: '',
        city: '',
        workEmail: `${INTERIM_ROOT_EMAIL_PREFIX}${id}@company.example`,
        companyJoinDate: new Date('1970-01-01'),
        createdBy: id,
      },
    });
  }
}
