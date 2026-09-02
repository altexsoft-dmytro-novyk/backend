import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  AuthUser,
  AuthUserLookupPort,
} from '../domain/interfaces/auth-user-lookup.port';

/**
 * Epic 2 Story 2.1 — active-user lookup for the magic-link request.
 *
 * "Active" keys on `User.isActive` (the account-level flag — auth/README
 * decision 5's recommendation) AND excludes anyone with a current
 * (`validTo IS NULL`) `dismissed` employment status as a secondary guard, so a
 * deactivated employee (Colin: both signals set) is indistinguishable from an
 * unknown address (DEC-UM-012). Matches the "current dismissed" predicate
 * `UserRepository.list` already uses.
 */
@Injectable()
export class AuthUserLookupRepository implements AuthUserLookupPort {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByWorkEmail(workEmail: string): Promise<AuthUser | null> {
    return this.prisma.user.findFirst({
      where: { workEmail, ...AuthUserLookupRepository.ACTIVE_PREDICATE },
      select: { id: true, workEmail: true },
    });
  }

  async findActiveById(userId: string): Promise<AuthUser | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, ...AuthUserLookupRepository.ACTIVE_PREDICATE },
      select: { id: true, workEmail: true },
    });
  }

  /**
   * "Active" keys on `User.isActive` (the account-level flag) AND excludes
   * anyone with a current (`validTo IS NULL`) `dismissed` employment status —
   * the applied-departure convergence (auth/README decision 5).
   */
  private static readonly ACTIVE_PREDICATE = {
    isActive: true,
    NOT: {
      employmentStatuses: { some: { validTo: null, status: 'dismissed' } },
    },
  } as const;
}
